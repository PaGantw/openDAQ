# openDAQ 瀏覽器量測工作台

以這份原始碼建出的 C++ SDK 操作裝置；Python 標準函式庫提供本機 HTTP 介面，前端不依賴 CDN、Node 或 Python openDAQ 套件。

## 功能

- 掃描 SDK 可探索的裝置、手動輸入 Native / OPC UA / LT WebSocket 連線字串、連線與中斷，以及選用裝置帳密登入。
- 檢視裝置、通道、訊號及功能方塊；讀取屬性，編輯可寫的字串、整數、浮點與布林屬性。複合／函式型屬性僅供檢視。
- 最多 16 個純量數值、TIME 或一維數值向量訊號的即時曲線、樣本計數、最小、最大、峰對峰、平均與 RMS；支援雙欄排列、顯示時窗、固定縱軸、拖曳／滾輪縮放與 A/B 游標。
- 前端 FFT 頻譜：512–8192 點、Hann／矩形窗、DC 移除、線性／dB 振幅及峰值頻率。以實際樣本時間估計取樣率，不以畫面更新率當作取樣率。
- 訊號搜尋、批次選取，以及擷取頁的設備通道屬性編輯。
- 使用 SDK 功能方塊（如縮放、統計、FFT），建立／移除方塊，接線與解除接線。FFT 等一維數值向量會依 SDK 維度座標顯示最新一幀，例如頻率軸為 Hz。訊號鏈頁每秒更新接線與已監測輸出的數值／縮圖。
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

在**執行後端的電腦**開啟瀏覽器，以上直接啟動 `server.py` 的指令預設為 `http://127.0.0.1:8080`。Windows 的 `start_windows.cmd` 則預設使用 `http://127.0.0.1:18080`，可帶入第一個參數選擇其他 port。Windows 使用 `python` 與 `.exe` 檔名；以實際產生的執行檔／模組目錄為準。Ctrl+C 會停止擷取、關閉錄製檔並結束 SDK 程序。

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

- 擷取以 100ms 週期、每純量訊號每次最多 16384 筆向 SDK 讀取，畫面保留最近 30 秒、每 10ms bucket 的首／最小／最大／末值（約 12,004 點上限）；另保留最近 8192 筆原始樣本供 FFT／近距離縮放。這是互動式工作台，**不保證高速擷取無遺失或多裝置硬體同步**。`待讀` 顯示 backlog；資料率高時需另行設計持續資料管線。單一 reader 錯誤會標示於該訊號，全部訊號失敗或 bridge 故障時才停止擷取與錄製。
- CSV 只含「開始錄製」至「結束錄製／停止擷取」間已讀取的樣本；結束時間精度以 polling 週期為準，沒有預觸發／事後補齊。每檔最多 200 萬筆或 256 MiB，達上限自動結束，擷取仍持續。
- 橫軸為每訊號首次讀到的 domain tick 相對秒數，不代表所有訊號共同起點或 UTC。CSV 的 origin／tick 比例可用於後續重建裝置時間。純量支援可轉換為 Float64、具 Int64 domain 的數值訊號；TIME 透過關聯數值訊號的 domain 讀取，不再替時間軸建立錯誤的雙重 domain reader。原始 tick 保留在 CSV。
- 為保留錄製一致性，擷取中禁止掃描、修改屬性、拓樸與載入組態；請先停止擷取。相依賴的設備能力（校正、同步、觸發、權限等）仍由實際裝置／SDK 模組決定，並非所有設備都提供相同功能。
- 協定連線逾時 45 秒後會結束 bridge，避免晚到回應套到後續操作。修正裝置網路後重新啟動程式。
- 已完成錄製檔保留在 `--recordings` 目錄；重啟後不重新列出歷史檔案，但可從該目錄直接取用。

## 量測畫面使用方式

- 「設定」可開啟該訊號所屬通道的真實屬性（依設備提供內容而定）。擷取中可檢視，但需先停止擷取才能套用變更。無通道的訊號會改開啟元件屬性。
- 「顯示時窗」可選最近 0.1／1／5／10 秒或全部緩衝資料；時窗範圍固定為指定秒數，啟動初期不足的部分留白；最多保留約 30 秒顯示歷史，不會憑空補出尚未取得的資料。
- 滑鼠工具選「拖曳縮放」，在圖中拖曳框選，或使用滾輪以指標為中心縮放。「顯示 A/B 游標」預設開啟；選「游標 A／B」後點擊圖表，會吸附到實際樣本並顯示時間、振幅、Δt、ΔY 及 1/|Δt|；最後一項只是游標間距倒數，不是自動頻率量測。游標模式可用左右鍵微調。
- 縮放／游標操作會凍結整個量測畫面（波形與 FFT）。後端擷取、統計與 CSV 錄製繼續執行。「繼續畫面」會回到即時資料並清除縮放／游標；雙擊單一圖可重設該圖，「重設縮放／游標」則重設所有圖。
- FFT 取分析訊號最近 N 筆原始資料，**不使用縮放後的可視區間**。Hann 使用 periodic Hann 並校正窗函數 coherent gain；顯示單邊峰值振幅，DC 與 Nyquist 不加倍。這不是 RMS、功率頻譜密度或 IEC 聲學分析。
- dB 為 `20 log10(振幅 / 1 單位)`，例如電壓為 dB re 1 V。顯示下限為 -240 dB；它不代表校正後的噪音底限。
- Fs 依樣本時間間距估計，Δf = Fs/N。資料不足、缺失或非等間隔時不產生 FFT；格點外的訊號會有頻譜洩漏，峰值頻率未做格點內插。
- 橫軸仍是各訊號自己的相對時間；多圖排列不代表跨裝置硬體同步。固定 Y 範圍會套用所有波形，請留意不同通道可能有不同單位。

數值回歸測試（僅開發時需要 Node，不是執行工作台的相依套件）：

```sh
node --test examples/applications/daq_web/tests/test_analysis.cjs
```

新增量測操作的瀏覽器測試：

```sh
python3 examples/applications/daq_web/tests/test_measurement_browser.py --url http://127.0.0.1:18080
```

該測試會建立獨立的參考裝置並修改參考通道頻率，請使用沒有既有裝置的測試 instance。

## TIME、向量與串流通道

- TIME 是 openDAQ domain 訊號，通常是某個數值訊號的時間軸。選取 TIME 時，工作台使用該數值來源的 reader 取得時間樣本，Y 顯示 tick × tick resolution（秒），時間原點另保留；不將它當成新的類比輸入。
- 顯示歷史會保留真實極值樣本，不是平均值。縮放到仍在原始 8192 筆範圍內時會使用原始資料；更舊的壓縮歷史無法恢復未保留的逐樣本細節。CSV 純量資料不受顯示壓縮影響。
- 一維數值向量大小上限 16384，支援 Float32/64 與 8/16/32/64 位整數。複數、結構、二維以上資料暫不支援，來源清單會標示並停用。
- 向量以 SDK 維度座標繪圖（如 Hz），不是時間歷史。每次最多讀取 32 幀，保留最新幀供顯示，已讀幀的每個元素各寫入一列 CSV。CSV 在原欄位後新增 `vector_index`、`dimension_coordinate`、`dimension_unit`；純量列的這三欄為空。
- TIME／向量與純量可同時讀取；單一訊號讀取錯誤會顯示在該圖，不會抹除其他有效資料。全部訊號失敗時會停止擷取並結束錄製。
- 訊號鏈僅對已選為擷取來源的輸出顯示即時數值／縮圖，未監測者會明確標示。編輯接線仍需停止擷取，以維持錄製一致性。
- 支援依 SDK 型態決定，沒有硬編碼只接受原廠 OD 的「FINAL VALUE」。設備透過 WebSocket、Native、OPC UA 公布的訊號與設定可能不同；原廠通道需以設備手冊及 SDK 描述比對。可按「匯出訊號描述」取得不含登入密碼的訊號清單。

這次更新需要重新建置 C++ bridge，請依 WINDOWS.md 的新版升級步驟操作；只覆蓋網頁檔案不夠。
