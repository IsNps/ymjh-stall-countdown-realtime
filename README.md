# 摊位倒计时 · 多人实时版

原版为单机网页（数据存 localStorage），现已改造为 **线上多人实时协作版**：

- 多人加入同一 **房间号**，分组 / 基准时间 / 物品倒计时的增删改 **实时同步** 给房间内所有人
- 支持一键复制 **邀请链接**，队友点开即入房
- 断线自动重连并补拉最新数据
- 保留原有全部功能：多分组、基准时间重算、偏移秒、到期提醒（浏览器通知）、长按删除/重命名、导入导出备份

## 技术方案

- **后端**：`server.js`，纯 Node.js 内置模块，**零依赖**
- **实时推送**：SSE（Server-Sent Events），服务器单线程权威应用操作后广播给所有客户端
- **数据存储**：`data/<房间号>.json` 文件（防抖 300ms 原子写入），无需数据库
- **前端**：`public/index.html`，操作级同步（addGroup / addItem / deleteItem / updateBase…），乐观更新 + 远程应用

## 运行

```bash
node server.js
# 或
npm start
```

打开 `http://localhost:3000`，新建房间 → 复制邀请链接发给队友即可。

- 自定义端口：`PORT=8080 node server.js`（Windows PowerShell: `$env:PORT=8080; node server.js`）
- 数据备份：直接复制 `data/` 目录下的 JSON 文件
- 需 Node.js ≥ 14

## 部署说明

任意能跑 Node.js 的平台均可（自有服务器、宝塔、Railway、Render、Fly.io 等）：

```bash
npm start   # 启动后监听 PORT 环境变量或 3000 端口
```

> 注意：GitHub Pages 只能托管静态页面，无法运行本项目的 Node 后端。GitHub 仓库用于源码托管，实际服务需部署到 Node 运行环境；也可用 pm2 守护：
> ```bash
> npm install -g pm2
> pm2 start server.js --name stall-countdown
> ```
