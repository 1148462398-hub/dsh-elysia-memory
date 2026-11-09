/**
 * client-smoke.mjs — 在没有浏览器的情况下验证 lib/client.js：
 * 它是经典脚本（非 ESM），所以这里用 new Function 注入一个假的 window 来执行，
 * 再用假的 require 提供 react，最后检查 apply() 往槽位里注册了什么。
 */
import fs from 'node:fs'
import assert from 'node:assert/strict'

const here = new URL('.', import.meta.url)
const source = fs.readFileSync(new URL('../lib/client.js', here), 'utf8')

let captured = null
const fakeWindow = {
  __ModuleLoader__: {
    load(mod) {
      captured = mod
    }
  }
}

// 经典脚本：在函数作用域里执行，window 通过参数传入。
new Function('window', source)(fakeWindow)

assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load')
assert.equal(captured.id, 'dsh-elysia-memory', 'id 必须是包名')
assert.equal(typeof captured.factory, 'function', 'factory 必须是函数')

// 极简 React 桩：只提供 client.js 真正用到的 6 个 API。
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children }
}
const React = {
  createElement,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn()
}

const required = []
const plugin = captured.factory((id) => {
  required.push(id)
  if (id === 'react') return React
  throw new Error(`client.js 不应 require 其它模块，却要了: ${id}`)
})
assert.deepEqual(required, ['react'], '只允许 require react')

assert.ok(plugin, 'factory 必须返回插件对象')
assert.deepEqual(plugin.inject, ['slots'], '必须 inject slots')
assert.equal(typeof plugin.apply, 'function')

// 假 ctx.slots：记录 inject 与 register 的调用。
const calls = []
const ctx = {
  slots: {
    inject(name, register) {
      calls.push({ kind: 'inject', name })
      register()
    },
    register(props, component) {
      calls.push({ kind: 'register', props, component })
    }
  }
}
plugin.apply(ctx)

assert.equal(calls.length, 6, `期望 6 次调用（3 inject + 3 register），实际 ${calls.length}`)
assert.deepEqual(
  calls.filter((c) => c.kind === 'inject').map((c) => c.name),
  ['main', 'sidebar.panellist', 'conversation.chat.turnTail']
)

const main = calls.find((c) => c.kind === 'register' && c.props.name === 'main')
assert.ok(main, '必须注册 main 面板')
assert.equal(main.props.key, 'dsh-elysia-memory', 'main 的 key 必须是包名（与侧边栏 id 对齐）')
assert.equal(typeof main.component, 'function')

const entry = calls.find((c) => c.kind === 'register' && c.props.name === 'sidebar.panellist')
assert.ok(entry, '必须注册 sidebar.panellist 图标')
assert.equal(entry.props.id, 'dsh-elysia-memory')
assert.equal(entry.props.order, 25)
assert.equal(typeof entry.props.label, 'function', 'label 用 thunk 以便跟随语言切换')
assert.equal(entry.props.label(), 'DSH-elysia')

// 两个组件都要能渲染（不触发副作用）。
const panel = main.component({})
assert.equal(panel.type, 'div', '面板根节点应是 div')
const icon = entry.component({ size: 20, active: true })
assert.equal(icon.type, 'svg', '图标应是 svg')
assert.equal(icon.props.width, 20, '图标尺寸应跟随 owner 传入的 size')
assert.equal(icon.props.strokeWidth, 2, '选中态描边应加粗')
const iconDefault = entry.component({})
assert.equal(iconDefault.props.width, 18, '未传 size 时兜底 18')

// 侧边栏图标不能吃掉点击。
assert.equal(icon.props.style.pointerEvents, undefined, '图标不要设置 pointerEvents')

// 口播气泡：注册了 turnTail 槽位，组件可渲染（无数据时返回 null）
const bubble = calls.find((c) => c.kind === 'register' && c.props.name === 'conversation.chat.turnTail')
assert.ok(bubble, '必须注册 conversation.chat.turnTail 槽位')
assert.equal(bubble.props.id, 'dsh-elysia-memory-bubble')
assert.equal(typeof bubble.component, 'function')

console.log('client-smoke: 全部通过（模块契约 + 槽位注册 + 组件渲染）')
