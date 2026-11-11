/**
 * 长期观测库：把「感知到的机器状态」和「值得记住的事件」按时间线存起来。
 *
 * 为什么要单独一个库，而不是塞进 MEMORY.md：
 *   · 感知层每 10 秒采一次，一天就 8600 条，人是读不了这种流水的，
 *     但「昨天下午三点机器烧到 96%」这种事后追问又需要它；
 *   · 主记忆是给人看的、要进提示词的，塞进这种量级会直接把上下文淹掉。
 * 所以这里只管「存得下、查得回」，给上层（气泡 / 工具 / 每日摘要）当底座。
 *
 * 设计上的三条硬约束（违反会让感知层把宿主拖垮）：
 *   1. 任何方法都不抛异常——存不进去是小事，把调用方炸了才是大事。
 *   2. 没有 `node:sqlite`、目录不可写、FTS5 编不出来，都要能活着退化成空实现。
 *   3. 全部同步 API（DatabaseSync 本身就是同步的），一次 append 一个事务，
 *      免得「写一半崩了」留下半截数据让统计对不上。
 */
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/*
 * `node:sqlite` 是 Node 22.5 才加的实验模块。导入失败在老版本 Node 上很常见，
 * 所以包在 try/catch 里：这台机器没有它，插件照样要能起来，只是观测功能静默失效。
 * 顶层 await 是 ESM 里唯一能在「模块加载期」拿到它的办法（同步 require 拿不到 ESM）。
 */
let sqlite = null
try {
  sqlite = await import('node:sqlite')
} catch {
  sqlite = null
}

/** 原始指标：采样频率高、单条价值低，过了 48 小时基本只占地方 */
const RAW_KINDS = ['cpu', 'mem', 'disk']
/** 单次查询上限：再大就不是「人看时间线」而是导出了，会把宿主卡住 */
const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 200
/** 每个时间桶最多带几条样本，够看出「那会儿在干什么」就行 */
const SAMPLE_LIMIT = 3
const HOUR_MS = 3_600_000

/*
 * 表结构。全部 `if not exists`——这个库会被反复打开（每次插件启动），
 * 迁移只能是「缺什么补什么」，不能假设自己是第一来的人。
 */
const SCHEMA = `
create table if not exists obs (
  id integer primary key,
  ts integer not null,
  kind text not null,
  level text not null,
  summary text not null,
  detail text
);
create index if not exists idx_ts on obs(ts);
create index if not exists idx_kind_ts on obs(kind, ts);
create table if not exists obs_meta (key text primary key, value text);
`

/*
 * FTS5 的 external content 表不会自动跟着主表动：
 * 少了这三个触发器，删掉的行会永远滞留在索引里被搜出来，
 * 而新写的行一条都搜不到——比不做全文索引更让人困惑。
 */
const FTS_TRIGGERS = `
create trigger if not exists obs_ai after insert on obs begin
  insert into obs_fts(rowid, summary) values (new.id, new.summary);
end;
create trigger if not exists obs_ad after delete on obs begin
  insert into obs_fts(obs_fts, rowid, summary) values ('delete', old.id, old.summary);
end;
create trigger if not exists obs_au after update on obs begin
  insert into obs_fts(obs_fts, rowid, summary) values ('delete', old.id, old.summary);
  insert into obs_fts(rowid, summary) values (new.id, new.summary);
end;
`

/** 写日志本身也不能把调用方带崩，所以再包一层 */
function safeWarn(logger, message, err) {
  try {
    const tail = err ? `：${err?.message ?? err}` : ''
    logger?.warn?.(`[observations] ${message}${tail}`)
  } catch {
    /* 日志器自己坏了就算了，观测库不该因此报错 */
  }
}

function finiteNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** limit 是外部输入（工具参数），越界值统一夹住，别让一句 limit: 1e9 把内存吃光 */
function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const n = Math.floor(finiteNumber(value) ?? 0)
  if (n <= 0) return fallback
  return Math.min(n, MAX_LIMIT)
}

function clampBucket(value) {
  const n = Math.round(finiteNumber(value) ?? 0)
  // 小于 1 秒的桶没有意义（采样间隔才 10 秒），直接当没传
  return n >= 1000 ? n : HOUR_MS
}

/**
 * detail 统一存成 JSON 字符串：SQLite 没有对象类型，
 * 存字符串才能让它保持「一个格子里放一整段结构化信息」。
 */
function detailText(detail) {
  if (detail == null) return null
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    // 循环引用之类序列化不了的东西，退化成 String，至少不丢这一行
    return String(detail)
  }
}

/** 读回来时能解析就解析回对象，调用方拿到的 detail 才和写进去时一样 */
function parseDetail(text) {
  if (text == null) return null
  const body = String(text)
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

/**
 * 把外部塞进来的行洗一遍。没 kind 或没 summary 的行直接丢：
 * 一条读不懂的观测等于没有，还占索引。
 */
function normalizeRow(raw) {
  if (!raw || typeof raw !== 'object') return null
  const kind = String(raw.kind ?? '').trim()
  const summary = String(raw.summary ?? '').trim()
  if (!kind || !summary) return null
  return {
    ts: Math.round(finiteNumber(raw.ts) ?? Date.now()),
    kind: kind.slice(0, 40),
    level: String(raw.level ?? '').trim().slice(0, 16) || 'info',
    // 摘要是一句话，超长的多半是把 detail 塞错了地方，砍掉防止索引膨胀
    summary: summary.length > 500 ? summary.slice(0, 500) : summary,
    detail: detailText(raw.detail)
  }
}

/** LIKE 的通配符要转义，否则用户搜 "100%" 会变成「任意东西」 */
function likePattern(keyword) {
  return `%${keyword.replace(/[\\%_]/g, (m) => '\\' + m)}%`
}

/**
 * 把用户输入变成 FTS5 的查询串。裸词会被 fts5 当成语法（AND/OR/NEAR/*），
 * 一句「还有吗？」能把整个查询打成语法错误，所以一律包成短语再做 AND。
 */
function ftsExpression(keyword) {
  return keyword
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' AND ')
}

function toRow(row) {
  return {
    id: Number(row.id),
    ts: Number(row.ts),
    kind: String(row.kind),
    level: String(row.level),
    summary: String(row.summary),
    detail: parseDetail(row.detail)
  }
}

class Observations {
  constructor(dir, logger, options = {}) {
    // 没给 dir 就彻底停用：不能退化成往 cwd 里偷偷建库，那是在用户家里乱扔垃圾
    this.dir = dir
    this.dbPath = dir ? path.join(dir, 'obs.db') : ''
    this.dailyDir = dir ? path.join(dir, 'daily') : ''
    this.logger = logger
    /** 强制关掉 FTS：一是排查用，二是给「这台机器的 fts5 编不出来」留条明路 */
    this.wantFts = options.fts !== false
    this.db = null
    this.fts = false
    this._init()
  }

  /** 建目录 → 开库 → 建表 → 建全文索引。任何一步失败都退化成空实现，绝不抛。 */
  _init() {
    if (this.db || !this.dir) return
    if (!sqlite?.DatabaseSync) {
      safeWarn(this.logger, '没有 node:sqlite，观测库停用（数据不会落盘）')
      return
    }
    try {
      mkdirSync(this.dir, { recursive: true })
      mkdirSync(this.dailyDir, { recursive: true })
    } catch (err) {
      safeWarn(this.logger, `观测目录建不出来（${this.dir}），观测库停用`, err)
      return
    }

    let db
    try {
      db = new sqlite.DatabaseSync(this.dbPath)
      // WAL：写观测的同时还能读，别让 10 秒一次的写入把查询卡住
      db.exec('pragma journal_mode = wal')
      // 插件可能被多开（多个宿主进程），让它们排队而不是直接报 SQLITE_BUSY
      db.exec('pragma busy_timeout = 4000')
      // 观测数据丢了不心疼，normal 少一次 fsync，省点磁盘抖动
      db.exec('pragma synchronous = normal')
      db.exec(SCHEMA)
    } catch (err) {
      safeWarn(this.logger, `观测库打不开（${this.dbPath}），观测功能停用`, err)
      try {
        db?.close()
      } catch {
        /* 关不掉也无所谓，进程退了就没了 */
      }
      return
    }

    this.db = db
    this.fts = this._initFts(db)
  }

  /**
   * FTS5 不是每个 Node 都编进去了。建不出来就得让关键字搜索退回 LIKE，
   * 而且要把 true/false 如实报给 stats()，上层才知道自己拿到的是哪种搜索。
   */
  _initFts(db) {
    if (!this.wantFts) return false
    try {
      const existed = Boolean(
        db.prepare("select name from sqlite_master where type = 'table' and name = 'obs_fts'").get()
      )
      if (!existed) {
        db.exec("create virtual table obs_fts using fts5(summary, content='obs', content_rowid='id')")
      }
      db.exec(FTS_TRIGGERS)
      if (!existed) {
        // 老库升级上来时，历史行都不在索引里；rebuild 会把它们一次性补进去
        db.exec("insert into obs_fts(obs_fts) values ('rebuild')")
      }
      return true
    } catch (err) {
      safeWarn(this.logger, 'FTS5 不可用，关键字搜索降级为 LIKE', err)
      return false
    }
  }

  /** 一次 append 一个事务：要么整批进去，要么一条都不留，统计才对得上 */
  append(rows) {
    if (!this.db) {
      safeWarn(this.logger, '观测库未就绪，本次写入丢弃')
      return 0
    }
    const list = Array.isArray(rows) ? rows : rows ? [rows] : []
    const prepared = list.map(normalizeRow).filter(Boolean)
    if (!prepared.length) return 0

    try {
      const insert = this.db.prepare(
        'insert into obs(ts, kind, level, summary, detail) values (?, ?, ?, ?, ?)'
      )
      this.db.exec('begin immediate')
      let inserted = 0
      try {
        for (const row of prepared) {
          insert.run(row.ts, row.kind, row.level, row.summary, row.detail)
          inserted++
        }
        this.db.exec('commit')
      } catch (err) {
        // 事务里任何一条失败都整批回滚，不能留下「一半」让时间线出现空洞
        try {
          this.db.exec('rollback')
        } catch {
          /* 回滚都失败说明连接已经废了，下面统一交给外层处理 */
        }
        throw err
      }
      return inserted
    } catch (err) {
      safeWarn(this.logger, '观测写入失败（已回滚）', err)
      return 0
    }
  }

  /**
   * 时间窗 + 种类 + 级别 + 关键字的组合查询。
   *
   * 关键字这里故意是「FTS 命中 或 LIKE 子串命中」：
   * fts5 默认的 unicode61 不切中文，整句会变成一个 token，
   * 搜「磁盘」在「磁盘空间不足」里永远搜不到——纯 FTS 会让中文用户以为功能坏了。
   * LIKE 兜住中文子串，FTS 负责英文单词 / 多词查询的排序与命中。
   */
  query(options = {}) {
    if (!this.db) return []
    const opts = options || {}
    const limit = clampLimit(opts.limit)

    const build = (useFts) => {
      const { where, params } = this._where(opts, useFts)
      return {
        sql: `select id, ts, kind, level, summary, detail from obs${where} order by ts desc, id desc limit ${limit}`,
        params
      }
    }

    try {
      let built = build(this.fts)
      let rows
      try {
        rows = this.db.prepare(built.sql).all(...built.params)
      } catch (err) {
        // 关键字里出现怪字符时 fts5 可能直接语法报错，退一步只用 LIKE，别让一次查询废掉
        if (!this.fts) throw err
        safeWarn(this.logger, 'FTS 查询失败，本次改用 LIKE', err)
        built = build(false)
        rows = this.db.prepare(built.sql).all(...built.params)
      }
      return rows.map(toRow)
    } catch (err) {
      safeWarn(this.logger, '观测查询失败', err)
      return []
    }
  }

  /** 拼 where。kinds / level / keyword 都走占位符，值一律绑定不拼进 SQL */
  _where(opts = {}, useFts = false) {
    const clauses = []
    const params = []

    const from = finiteNumber(opts.from)
    if (from != null) {
      clauses.push('ts >= ?')
      params.push(Math.round(from))
    }
    const to = finiteNumber(opts.to)
    if (to != null) {
      clauses.push('ts <= ?')
      params.push(Math.round(to))
    }

    const rawKinds = Array.isArray(opts.kinds) ? opts.kinds : opts.kinds ? [opts.kinds] : []
    const kinds = rawKinds.map((k) => String(k ?? '').trim()).filter(Boolean)
    if (kinds.length) {
      clauses.push(`kind in (${kinds.map(() => '?').join(', ')})`)
      params.push(...kinds)
    }

    const level = String(opts.level ?? '').trim()
    if (level) {
      clauses.push('level = ?')
      params.push(level)
    }

    const keyword = String(opts.keyword ?? '').trim()
    if (keyword) {
      const pattern = likePattern(keyword)
      if (useFts) {
        clauses.push(
          "(id in (select rowid from obs_fts where obs_fts match ?) or summary like ? escape '\\')"
        )
        params.push(ftsExpression(keyword), pattern)
      } else {
        clauses.push("summary like ? escape '\\'")
        params.push(pattern)
      }
    }

    return {
      where: clauses.length ? ` where ${clauses.join(' and ')}` : '',
      params
    }
  }

  /**
   * 按桶聚合，只返回有数据的桶——空桶补零会让「看一晚上时间线」变成几千个空对象，
   * 前端还得自己再筛一遍，不如不给。
   */
  timeline(options = {}) {
    if (!this.db) return []
    const opts = options || {}
    const bucketMs = clampBucket(opts.bucketMs)
    try {
      const { where, params } = this._where(opts, false)
      const buckets = new Map()

      const aggSql = `
        select cast(ts / ? as integer) * ? as bucket, kind, count(*) as c
        from obs${where}
        group by bucket, kind
        order by bucket asc`
      for (const row of this.db.prepare(aggSql).all(bucketMs, bucketMs, ...params)) {
        const key = Number(row.bucket)
        let bucket = buckets.get(key)
        if (!bucket) {
          bucket = { bucketStart: key, count: 0, kinds: {}, samples: [] }
          buckets.set(key, bucket)
        }
        const n = Number(row.c) || 0
        bucket.count += n
        bucket.kinds[String(row.kind)] = n
      }

      // 每桶取最近 3 条当样本：窗口函数一次扫完，比按桶再查一遍省得多
      const sampleSql = `
        select * from (
          select cast(ts / ? as integer) * ? as bucket, id, ts, kind, level, summary, detail,
                 row_number() over (partition by cast(ts / ? as integer) order by ts desc, id desc) as rn
          from obs${where}
        ) where rn <= ${SAMPLE_LIMIT}`
      for (const row of this.db
        .prepare(sampleSql)
        .all(bucketMs, bucketMs, bucketMs, ...params)) {
        const bucket = buckets.get(Number(row.bucket))
        if (bucket) bucket.samples.push(toRow(row))
      }

      return [...buckets.values()].sort((a, b) => a.bucketStart - b.bucketStart)
    } catch (err) {
      safeWarn(this.logger, '时间线聚合失败', err)
      return []
    }
  }

  /**
   * 按「本地日历天」汇总。用 SQLite 的 localtime 而不是在 JS 里切日期，
   * 是为了让「一天」的定义跟用户看到的钟一致（跨时区 / 夏令时都不用自己算）。
   */
  dayProfile(options = {}) {
    if (!this.db) return []
    try {
      const { where, params } = this._where(options || {}, false)
      const sql = `
        select date(ts / 1000, 'unixepoch', 'localtime') as day,
               kind,
               count(*) as c,
               sum(case when level = 'warn' then 1 else 0 end) as w
        from obs${where}
        group by day, kind
        order by day asc`
      const days = new Map()
      for (const row of this.db.prepare(sql).all(...params)) {
        const day = String(row.day)
        let entry = days.get(day)
        if (!entry) {
          entry = { day, count: 0, byKind: {}, warnCount: 0 }
          days.set(day, entry)
        }
        const n = Number(row.c) || 0
        entry.count += n
        entry.byKind[String(row.kind)] = n
        entry.warnCount += Number(row.w) || 0
      }
      return [...days.values()]
    } catch (err) {
      safeWarn(this.logger, '每日汇总失败', err)
      return []
    }
  }

  /** bytes 把 -wal / -shm 也算上：WAL 模式下刚写完的数据还躺在 wal 里，只看主库会少报 */
  stats() {
    const empty = { rows: 0, firstTs: null, lastTs: null, bytes: 0, fts: this.fts }
    if (!this.db) return empty
    try {
      const row = this.db.prepare('select count(*) as c, min(ts) as lo, max(ts) as hi from obs').get()
      return {
        rows: Number(row?.c) || 0,
        firstTs: row?.lo == null ? null : Number(row.lo),
        lastTs: row?.hi == null ? null : Number(row.hi),
        bytes: this._bytes(),
        fts: this.fts
      }
    } catch (err) {
      safeWarn(this.logger, '观测统计失败', err)
      return empty
    }
  }

  _bytes() {
    let total = 0
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        total += statSync(this.dbPath + suffix).size
      } catch {
        /* wal/shm 平时可能不存在，这是正常状态 */
      }
    }
    return total
  }

  /**
   * 保留策略：原始指标 48 小时、事件 90 天。
   * 删完只在「这个月还没收拾过」时 VACUUM——VACUUM 会把整库重写一遍，
   * 每 6 小时跑一次的话反而成了磁盘负担。
   */
  prune(options = {}) {
    const opts = options || {}
    const rawHours = finiteNumber(opts.rawKeepHours)
    const eventHours = finiteNumber(opts.eventKeepHours)
    const rawKeep = rawHours == null ? 48 : Math.max(0, rawHours)
    const eventKeep = eventHours == null ? 2160 : Math.max(0, eventHours)
    const result = { deleted: 0, vacuumed: false }
    if (!this.db) return result

    try {
      const now = Date.now()
      const rawCut = now - rawKeep * HOUR_MS
      const eventCut = now - eventKeep * HOUR_MS
      const placeholders = RAW_KINDS.map(() => '?').join(', ')
      const info = this.db
        .prepare(
          `delete from obs where (kind in (${placeholders}) and ts < ?) or (kind not in (${placeholders}) and ts < ?)`
        )
        .run(...RAW_KINDS, rawCut, ...RAW_KINDS, eventCut)
      result.deleted = Number(info?.changes) || 0
    } catch (err) {
      safeWarn(this.logger, '观测清理失败', err)
      return result
    }

    if (result.deleted > 0 && this._vacuumDue()) {
      try {
        this.db.exec('vacuum')
        this.db.prepare('insert or replace into obs_meta(key, value) values (?, ?)').run(
          'lastVacuumAt',
          String(Date.now())
        )
        result.vacuumed = true
      } catch (err) {
        safeWarn(this.logger, '观测库 VACUUM 失败（不影响数据）', err)
      }
    }
    return result
  }

  /** 同一个月里已经 VACUUM 过就不再动手 */
  _vacuumDue() {
    try {
      const row = this.db.prepare("select value from obs_meta where key = 'lastVacuumAt'").get()
      const last = Number(row?.value)
      if (!Number.isFinite(last) || last <= 0) return true
      const a = new Date(last)
      const b = new Date()
      return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth()
    } catch {
      // 元数据读不出来就保守地不 VACUUM，反正不是必须做的事
      return false
    }
  }

  /** 清空：删库文件 + daily/*.md，然后立刻重建一个空库，这样 purge 之后 stats() 还能用 */
  purge() {
    this.close()
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(this.dbPath + suffix, { force: true })
      } catch (err) {
        safeWarn(this.logger, `删不掉 ${this.dbPath}${suffix}`, err)
      }
    }
    try {
      for (const name of readdirSync(this.dailyDir)) {
        if (!/\.md$/i.test(name)) continue
        rmSync(path.join(this.dailyDir, name), { force: true })
      }
    } catch {
      /* daily 目录本来就可能不存在 / 删不掉，purge 不该因此失败 */
    }
    this._init()
    return true
  }

  /**
   * 每日摘要落成 Markdown。先写临时文件再 rename：
   * 半截文件比没有文件更糟——上层会把它当完整摘要索引进记忆。
   */
  writeDailySummary(day, markdown) {
    if (!this.dir) return null
    const key = String(day ?? '').trim().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      safeWarn(this.logger, `日报日期不合法（${day}），应为 YYYY-MM-DD`)
      return null
    }
    const body = String(markdown ?? '')
    if (!body.trim()) return null

    const file = path.join(this.dailyDir, `${key}.md`)
    const tmp = `${file}.${process.pid}.tmp`
    try {
      mkdirSync(this.dailyDir, { recursive: true })
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, file)
      return file
    } catch (err) {
      safeWarn(this.logger, `日报写入失败（${file}）`, err)
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* 临时文件删不掉也只是留个垃圾，不值得再报一次 */
      }
      return null
    }
  }

  /** 幂等关闭；之后所有方法都变成安全空操作，不会因为「用完没关」或「关了还用」爆炸 */
  close() {
    const db = this.db
    this.db = null
    this.fts = false
    if (!db) return
    try {
      db.close()
    } catch (err) {
      safeWarn(this.logger, '观测库关闭失败', err)
    }
  }
}

/**
 * 打开（必要时创建）观测库。
 *
 * @param {object} options
 * @param {string} options.dir 观测目录本身（`obs.db` 和 `daily/` 都放在它下面），
 *                             由调用方拼成 `<stateDir>/observations` 传进来。
 * @param {object} [options.logger] 只要有个能用的 `warn` 就行
 * @param {boolean} [options.fts=true] 传 false 强制走 LIKE（排查 / fts5 缺失环境）
 * @returns {Observations} 永远返回实例；没开起来时各方法退化成空结果
 */
export function openObservations({ dir, logger, fts = true } = {}) {
  const target = String(dir ?? '').trim()
  if (!target) {
    safeWarn(logger, 'openObservations 没给 dir，观测库停用')
    return new Observations('', logger, { fts })
  }
  return new Observations(path.resolve(target), logger, { fts })
}

export default openObservations
