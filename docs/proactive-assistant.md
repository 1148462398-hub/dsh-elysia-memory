# 主动助手：感知 / 长期记忆 / B站只读采集（设计稿）

> 目标：让 `dsh-elysia-memory` 从「你派活我干活」变成「我知道你在做什么，也记得住」。
> 本文是三个新模块的**唯一真相**，实现与集成都以它为准。

## 0. 铁律（三条，任何模块都必须遵守）

1. **默认关**。感知、B站采集都默认禁用，用户显式打开才跑。
2. **只读**。B站模块**绝不登录、绝不发帖、绝不点赞评论**。它只产出「待审草稿」，最后一步永远由用户手动完成。
3. **不塞主记忆**。观测数据进 SQLite，**不进 `MEMORY.md`**；只有「每日摘要」这一层才允许进记忆的 docs 分区。

## 1. `lib/observations.js` —— 长期观测库

纯 Node，只依赖 `node:sqlite` / `node:fs` / `node:path`。

### 存储位置
`<stateDir>/observations/obs.db`，以及 `<stateDir>/observations/daily/YYYY-MM-DD.md`。

### 表结构
```sql
create table obs (
  id integer primary key,
  ts integer not null,        -- 毫秒时间戳
  kind text not null,         -- cpu|mem|disk|proc|net|window|file|event|security|bili
  level text not null,        -- info|notice|warn
  summary text not null,      -- 一句话，给人看
  detail text                 -- JSON 字符串，可空
);
create index idx_ts on obs(ts);
create index idx_kind_ts on obs(kind, ts);
create virtual table obs_fts using fts5(summary, content='obs', content_rowid='id');
```
FTS5 **可能不可用**：建表失败要降级成「只有 LIKE 搜索」，不能抛。

### 导出 API（全部同步或返回 Promise，二选一但要一致）
```js
openObservations({ dir, logger })            // -> Obs 实例
obs.append(rows)                             // rows: {ts?, kind, level?, summary, detail?}[]  -> number
obs.query({ from, to, kinds, level, keyword, limit })  // -> rows[]
obs.timeline({ from, to, bucketMs = 3600_000 })        // -> {bucketStart, count, kinds:{k:n}, samples:[]}[]
obs.dayProfile({ from, to })                 // -> {day, count, byKind, warnCount}[]
obs.stats()                                  // -> {rows, firstTs, lastTs, bytes, fts}
obs.prune({ rawKeepHours = 48, eventKeepHours = 2160 })  // 原始指标 48h，事件 90 天; -> {deleted}
obs.purge()                                  // 删库 + 删 daily/*
obs.writeDailySummary(day, markdown)         // 写 daily/YYYY-MM-DD.md
obs.close()
```
- 写入用批量事务（一次 `append` 一个事务），开 `journal_mode=WAL`。
- `append` 遇到任何异常返回 0 并 `logger.warn`，**绝不抛**（感知层不能因为存不了就崩）。
- `query` 上限 `limit` 默认 200、最大 1000。

### 保留策略（`prune` 由插件每 6 小时调用一次）
- `kind in (cpu, mem, disk)` 超过 `rawKeepHours` 删除
- 其余超过 `eventKeepHours` 删除
- 删除后按需 `VACUUM`（每月一次，别每次）

## 2. `lib/senses.js` —— 自我感知

纯 Node；**只用 `node:os` + `node:fs`**，不 spawn 任何进程（前台窗口这类需要 user32 的，本期**不做**，留 TODO）。

### 采集（全部 < 1ms）
```js
sampleCheap()   // -> {ts, cpuRatio, memRatio, loadAvg?, freeMem, totalMem, uptimeSec}
```
- `cpuRatio` 用 `os.cpus()` 两次采样的 idle/total 差值算，**第一次返回 null**（没有基线）。
- `memRatio = 1 - os.freemem()/os.totalmem()`。

### 监听器
```js
createSenses({ intervalSec = 10, logger, thresholds })  // -> Senses
s.start()          // 开始采样；幂等
s.stop()           // 清 timer；幂等
s.sampleNow()      // 立刻采一次 -> sample
s.status()         // {running, intervalSec, lastSample, lastEventAt}
s.on('sample', fn) // fn(sample)
s.on('event', fn)  // fn({ts, kind, level, summary, detail})
```
- `thresholds`: `{cpu: 90, cpuHoldSec: 120, mem: 92, diskFreeGB: 5, diskPath: 'C:'}`（都可覆盖）
- 触发规则：**持续**超阈值（连续 N 次采样都超）才发一次 `event`，发完进入 `cooldownSec`（默认 900）抑制重复。
- 事件 `summary` 是中文人话，例如：`CPU 连续 2 分钟高于 90%（现在 96%），可能是某个程序在满载`
- 磁盘检查每 20 次采样做一次（`fs.statfsSync` 可用就用，不可用就跳过，不报错）。
- `unref()` 所有 timer，别拖住宿主退出。
- 任何异常 → `logger.warn` + 跳过这一次，**不抛**。

## 3. `lib/bilibili.js` —— 只读采集 + 待审队列

### 采集（无登录，只用公开接口）
```js
fetchPopular({ limit = 20, pn = 1, fetchImpl })   // -> videos[]
// GET https://api.bilibili.com/x/web-interface/popular?ps=&pn=
// headers: UA(常见浏览器) + Referer: https://www.bilibili.com
fetchComments({ oid, pn = 1, limit = 20, fetchImpl })  // -> comments[]   oid = aid
```
- 返回体 `code !== 0` 视为失败，返回 `{ok:false, reason}`，**不抛**。
- 限速：模块级 1 秒最多 1 个请求；`412/429` 触发 5 分钟退避（记住 `blockedUntil`）。
- 超时 10 秒；`fetchImpl` 可注入（测试用 stub）。

### 待审队列（核心）
```js
openReview({ dir, logger })   // -> Review
review.enqueue(item)   // item: {kind:'reply'|'recommend', url, title, draft, why, meta?}
                       // 去重键 = url + hash(draft)；重复返回 {added:false}
review.list({ status = 'draft', limit = 20 })   // -> items[]
review.get(id)
review.setStatus(id, status)   // draft|approved|rejected|posted
review.renderMarkdown(items)   // -> 给用户看的审核清单（带 AI 标识提示 + 操作说明）
review.stats()
```
- 存储：`<stateDir>/review/queue.json`（原子写：tmp + rename）。
- 状态机：`draft → approved → posted`，或 `draft → rejected`。**没有自动流转**。
- 上限 500 条，超出丢最旧的 `posted`/`rejected`。

### 草稿生成（不调模型，纯规则）
```js
buildCandidate({ video, comment, profile })  // -> {kind, url, title, draft, why}
```
- `draft` 强制以 `（AI 生成）` 开头 —— 这是《人工智能生成合成内容标识办法》要求的显式标识。
- `why` 说明「为什么想回/想推荐」，一句话中文。

## 4. 集成（由主 agent 做，子 agent 不要碰）
- `lib/index.js`：装配三个模块 + 6 小时 prune 定时器 + 感知事件 → 观测库 → 气泡
- `lib/tools.js`：新增 `memory_file_timeline`、`memory_file_review`
- `dsh/cordis.patch.yml`：`observations`/`senses`/`bilibili` 三组配置，全部 `enabled: false`

## 5. 测试要求
每个模块一个 `test/*-smoke.mjs`，用临时目录，跑完自清理：
- observations：写入 → 查询 → FTS → timeline → dayProfile → prune → purge；**目录不存在不报错**；FTS5 缺失降级路径
- senses：sampleNow 有值；阈值连续触发 + 冷却；stop 后不再触发；异常不抛
- bilibili：stub fetch 正常/失败/退避；队列去重、状态机非法流转被拒、原子写

---

## 6. 实现状态（2026-11-11）

三块都已落地并接进 `lib/index.js`，**默认全部关闭**，配置在 `dsh/cordis.patch.yml` 的 `observations` / `senses` / `bilibili` 三组。

| 模块 | 文件 | 自检 |
|---|---|---|
| 观测库 | `lib/observations.js` | `test/observations-smoke.mjs`（86 项） |
| 感知 | `lib/senses.js` | `test/senses-smoke.mjs`（75 项） |
| B 站只读 + 待审 | `lib/bilibili.js` | `test/bilibili-smoke.mjs` |

配套工具：`memory_file_timeline`（按时间窗查观测库）、`memory_file_review`（看待审草稿，**不含发帖能力**）。

### 怎么开

```yaml
observations:
  enabled: true      # 建议只先开这一个，它不会主动打扰你
senses:
  enabled: false     # 感知会主动说话，等观测库跑顺了再开
bilibili:
  enabled: false     # 每 3 小时抓一次热门，只产草稿
```

改完要重启 DSH。

### 数据落在哪

```
<记忆目录>/observations/obs.db       观测库（SQLite，WAL）
<记忆目录>/observations/daily/*.md   每日摘要（几百字节，永久留）
<记忆目录>/review/queue.json         待审草稿队列
```

**都不进 `MEMORY.md`**——那个文件每轮都进提示词，观测数据只能是按需查询。

### 已知边界

1. **B 站评论抓不到**：`/x/v2/reply` 不登录返回空，`/wbi/main` 不带签名 -403。所以「推荐视频」可用，「回复网友」接不上。
2. **磁盘告警慢**：按「连续 N 次」统一口径，默认约 40 分钟才报第一次。
3. **观测库要 Node ≥ 22.5**：老版本会自动降级成空实现并跳过，不会崩。
4. 每日摘要在启动 3 分钟后生成昨天与今天，之后每 6 小时刷新。