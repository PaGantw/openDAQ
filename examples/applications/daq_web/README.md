# openDAQ 瀏覽器量測工作台

以這份原始碼建出的 C++ SDK 操作裝置；Python 標準函式庫提供本機 HTTP 介面，前端不依賴 CDN、Node 或 Python openDAQ 套件。

## 功能

- 掃描 SDK 可探索的裝置、手動輸入 Native / OPC UA / LT WebSocket 連線字串、連線與中斷，以及選用裝置帳密登入。
- 檢視裝置、通道、訊號及功能方塊；讀取屬性，編輯可寫的字串、整數、浮點與布林屬性。複合／函式型屬性僅供檢視。
- 最多 16 個純量數值訊號的即時曲線、樣本計數、最小、最大、平均與 RMS。
- 使用 SDK 功能方塊（如縮放、統計、FFT），建立／移除方塊，接線與解除接線。FFT 等向量輸出目前不支援曲線顯示。
- CSV 錄製／下載，保留每個樣本的訊號 ID、domain origin、原始 Int64 domain tick（不經 JavaScript 浮點轉換）、tick 比例與相對秒數。
- SDK 組態 JSON 匯出／載入，操作紀錄與 SDK 錯誤顯示。

## 建置

先依 repository 根目錄 `README.md` 安裝 C++ 編譯器、CMake **3.25+**、Git、Python **3.10+**，Linux/macOS 另需可執行 RTGen 的 Mono。Linux 可用 Ninja。依賴由 SDK 自行擷取，保持 TLS 與 checksum 驗證開啟。

從 repository 根目錄執行：

```sh
python3 examples/applications/daq_web/build.py
```

預設使用 `build/daq-web`，Release 組態與最多 4 個編譯工作。可指定 `--build-dir`、`--build-type Debug`、`--parallel 2`。建置腳本會開啟三種網路客戶端、參考裝置與無視窗參考功能方塊；不需要 Python bindings 或 SFML。

在目前雲端工作區，已測試的建置可直接使用：

```sh
export PATH=/workspace/opendaq-system/bin:/workspace/opendaq-tools/bin:$PATH
python3 examples/applications/daq_web/build.py --build-dir /workspace/opendaq-build --build-type Debug
```

## 啟動

```sh
python3 examples/applications/daq_web/server.py \
  --bridge build/daq-web/bin/daq_web_bridge \
  --modules build/daq-web/bin \
  --recordings build/daq-web/recordings
```

目前雲端工作區的對應指令：

```sh
python3 examples/applications/daq_web/server.py \
  --bridge /workspace/opendaq-build/bin/daq_web_bridge \
  --modules /workspace/opendaq-build/bin \
  --recordings /workspace/openDAQ/build/daq-web-recordings
```

在**執行後端的電腦**開啟瀏覽器，連到 `http://127.0.0.1:8080`。Windows 使用 `python` 與 `.exe` 檔名；以實際產生的執行檔／模組目錄為準。Ctrl+C 會停止擷取、關閉錄製檔並結束 SDK 程序。

這是單人、本機工作台：所有分頁共用同一個 SDK instance 與擷取工作。預設只監聽 loopback。若要透過其他網路公開服務，需自行提供具驗證與 TLS 的反向代理；程式沒有帳號登入系統。

## 連接 `169.254.27.27`

此位址屬於 link-local，雲端通常無法直接路由。請將本程式後端放在與裝置直接相連的電腦，確認網卡已配置裝置要求的相容 IPv4 網段，並允許裝置探索／協定使用的網路流量。

1. 按「掃描裝置」，優先使用裝置回報的連線字串。
2. 掃描不到時，以裝置啟用的服務手動連線，例如 `daq.nd://169.254.27.27` 或 `daq.opcua://169.254.27.27`；自訂模式可填入裝置所需 port／path。**IP 本身無法判斷裝置支援哪個協定。**
3. 裝置若需要驗證，可展開「裝置登入」填入帳密後連線；不需在聊天中提供。連線後選取通道，修改所需屬性（取樣率、量程等由裝置實際提供）。
4. 到「擷取與波形」選擇純量數值訊號，開始擷取，再按「開始錄製」。
5. 結束錄製後，到「組態與紀錄」下載 CSV；需要時再停止擷取／中斷裝置。

遠端雲端的 mDNS 掃描不代表能掃到本機 LAN。此 IP 的實體連線與取樣尚需於可接觸該設備的電腦驗證。程式不會將模擬資料冒充實體裝置資料。

## 無硬體驗證

掃描清單中的 `daqref://device0` 等項目明確標為 SDK 參考裝置。可用它驗證 UI、屬性、波形、功能方塊及 CSV 流程。

```sh
python3 examples/applications/daq_web/tests/test_workstation.py \
  --bridge build/daq-web/bin/daq_web_bridge --modules build/daq-web/bin
```

測試會自啟一個本機 HTTP server，使用真正 SDK 參考裝置；不需要也不會連到實體設備。

若建置時啟用了 SDK tests，也可執行 `ctest --test-dir build/daq-web -R '^test_daq_web$' --output-on-failure`。

選用的真實瀏覽器測試（先啟動工作台，再安裝 Playwright 及 Chromium）：

```sh
python3 examples/applications/daq_web/tests/test_browser.py
```

可用 `--browser /path/to/chromium` 指定現有瀏覽器；`--output` 指定截圖、錄製與組態測試產物目錄。測試會在執行中的工作台新增參考裝置與功能方塊，完成後移除，請使用沒有既有裝置／方塊的獨立測試 instance。

## 資料與限制

- 擷取以 100ms 週期、每訊號每次最多 8192 筆向 SDK 讀取，畫面保留最近 2000 筆。這是互動式工作台，**不保證高速擷取無遺失或多裝置硬體同步**。`待讀` 顯示 backlog；資料率高時需另行設計持續資料管線。SDK reader 錯誤會停止擷取與錄製並回報。
- CSV 只含「開始錄製」至「結束錄製／停止擷取」間已讀取的樣本；結束時間精度以 polling 週期為準，沒有預觸發／事後補齊。每檔最多 200 萬筆或 256 MiB，達上限自動結束，擷取仍持續。
- 橫軸為每訊號首次讀到的 domain tick 相對秒數，不代表所有訊號共同起點或 UTC。CSV 的 origin／tick 比例可用於後續重建裝置時間。只有可轉換為 Float64、具 Int64 domain 的純量訊號可擷取。
- 為保留錄製一致性，擷取中禁止掃描、修改屬性、拓樸與載入組態；請先停止擷取。相依賴的設備能力（校正、同步、觸發、權限等）仍由實際裝置／SDK 模組決定，並非所有設備都提供相同功能。
- 協定連線逾時 45 秒後會結束 bridge，避免晚到回應套到後續操作。修正裝置網路後重新啟動程式。
- 已完成錄製檔保留在 `--recordings` 目錄；重啟後不重新列出歷史檔案，但可從該目錄直接取用。
