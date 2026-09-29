// OpenCode 目录型插件入口。
// opencode 加载 file:// 目录插件时默认在包根查找 index.* 入口；
// 这里重新导出真正的 V2 实现（src/index.js），确保插件被正确识别与加载。
export { default } from "./src/index.js";
export * from "./src/index.js";
