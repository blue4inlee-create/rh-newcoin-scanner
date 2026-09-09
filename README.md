# RH Newcoin Scanner

Robinhood Chain 新币 Discovery / Canary 扫描器。

当前部署版本：`v1.6.3`

主要监听：
- Pons Current / Legacy / V2
- pools.trade Current / Original
- Uniswap V3 PoolCreated
- Uniswap V4 Initialize / Swap
- 首次真实成交与 Canary 升级
- 启动回补与 429 限流退避

默认以 `DRY_RUN=1` 启动，不写 Google Sheet，不自动交易。

生产环境切换 LIVE 前必须配置：
- `SHEET_WEBHOOK_URL`
- `SHEET_INGEST_SECRET`

Docker 构建阶段会重新拼接 `src/rh_newcoin_scanner_v1.part*`，并校验完整源码 SHA256：

`a03ae7dda84e4db8322b912756c176911b419d2e7bdff968aedd4abb3909684c`
