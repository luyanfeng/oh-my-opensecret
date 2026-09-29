/**
 * 进程级单例协调（oh-my-opensecret）
 *
 * ## 为什么需要
 *
 * OpenCode 2.x 的 server 进程里，**每个 location（项目目录）各加载一份插件实例**。
 * 本插件脱敏/还原是 in-place 改写协议体，若 N 份实例各自注册同一批 hook，
 * 虽然脱敏/还原本身是幂等的（占位符不会被二次改写），但会多出 N 套：
 * - N 次 `context` 遍历（对同一份 messages，浪费但仍正确）
 * - N 次 `http.response` 流改写（对同一份响应体，浪费但仍正确）
 * - N 个独立的占位符映射表（同一进程内分散，易失效、占内存）
 *
 * 用户明确要求「同一 opencode server 进程只能有一个本插件实现」，
 * 因此这里用 `globalThis` 做进程级会合点，保证**只有一份 active 实例真正注册 hook**，
 * 其余实例处于空转（不注册 hook、不持有映射表）。
 *
 * ## 为什么用 globalThis 而不能用模块级变量
 *
 * 实测（探针，见 opencode-notify 的 process-singleton.ts）：
 * 同一 entrypoint 在同一进程内被求值为 **N 份互相独立的模块**
 * （moduleID 各不相同，模块级计数器恒为 1），模块级状态互不共享。
 * `globalThis` 才是进程级共享的（跨 location 单调递增），是唯一可行的会合点。
 * `ctx.storage` 也不行 —— 它是 per-location 隔离的（落盘按 location 分目录）。
 *
 * ## 选举规则：最新注册者上位
 *
 * 宿主在插件文件变化重载时会调用 cleanup（日志里能看到「插件卸载」），
 * 所以「首个注册者上位 + teardown 交接」并非不能用，但它把正确性押在
 * "宿主每次都调用 cleanup" 上：一旦有例外（只加载新实例而不卸载旧实例），
 * 第一个实例就会一直占着 owner，改配置/改代码都不生效，新实例只能干等。
 *
 * 因此改为**每个新注册的实例直接夺权**：旧 owner 显式让位（停 hook + 清空映射表），
 * 新实例上位。owner 身份存在共享 runtime 上，`isActive()` 动态比对，
 * 被让位的旧实例同步得知自己不再是 owner，立刻空转。两种时序都成立：
 * 宿主调 cleanup 时走 release 交接，不调时新实例照样上位。
 *
 * 让位后的实例完全空闲（不注册 hook），只留在列表里等待接替；
 * 万一 teardown 真被调用（进程退出 / location 关闭），则把 owner 交给
 * 当前最新注册且仍存活的实例。两条路径叠加，覆盖宿主所有加载/卸载时序。
 *
 * JS 单线程 ⇒ 注册 / 夺权 / 让位全在同一个同步块内完成，不存在竞态。
 */

const RUNTIME_KEY = "__ohMyOpenSecretRuntime__"

/**
 * @typedef {Object} SingletonSlot
 * @property {string} id 实例标识，仅用于日志（一般是 location 目录）
 * @property {() => void} activate 上位为活动实例时调用：注册 hook + 持有映射表
 * @property {() => void} deactivate 从活动实例退位时调用：停 hook + 清空映射表
 */

/** @returns {{ slots: SingletonSlot[], owner: SingletonSlot | null }} */
function getRuntime() {
  const g = /** @type {any} */ (globalThis)
  const existing = g[RUNTIME_KEY]
  if (existing) return existing
  const created = { slots: [], owner: null }
  g[RUNTIME_KEY] = created
  return created
}

export class ProcessSingleton {
  /** @type {SingletonSlot} */
  #slot
  /** @type {{ slots: SingletonSlot[], owner: SingletonSlot | null }} */
  #runtime
  /** @type {boolean} */
  #released = false

  /** @param {SingletonSlot} slot */
  constructor(slot) {
    this.#slot = slot
    this.#runtime = getRuntime()
    this.#runtime.slots.push(slot)
    // 最新注册者直接夺权：不能等旧 owner 自觉退位（它要等宿主调 cleanup 才退）
    const previous = this.#runtime.owner
    this.#runtime.owner = slot
    if (previous && previous !== slot) previous.deactivate()
    slot.activate()
  }

  /** 本实例当前是否为活动实例（只有它才注册 hook / 持有映射表） */
  isActive() {
    return !this.#released && this.#runtime.owner === this.#slot
  }

  /**
   * 释放槽位（teardown 时调用）。
   * 若自己是 owner：先退位，再把 owner 交给当前最新注册的实例。
   */
  release() {
    if (this.#released) return
    this.#released = true
    const index = this.#runtime.slots.indexOf(this.#slot)
    if (index >= 0) this.#runtime.slots.splice(index, 1)
    if (this.#runtime.owner !== this.#slot) return
    this.#slot.deactivate()
    this.#runtime.owner = null
    const next = this.#runtime.slots[this.#runtime.slots.length - 1]
    if (!next) return
    this.#runtime.owner = next
    next.activate()
  }
}
