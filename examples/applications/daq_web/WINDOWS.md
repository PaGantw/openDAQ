# Windows 首次安裝與測試 Digibox

這是完整原始碼套件，不是已編譯的 Windows 安裝程式。工作台與 SDK 已在 Linux 建置並通過 SDK／瀏覽器測試；以下 Windows 步驟尚未在 Windows 實機驗證。

## 1. 安裝工具（一次即可）

1. **Visual Studio 2022 Community**：https://visualstudio.microsoft.com/vs/older-downloads/ 。在 Visual Studio Installer 勾選「使用 C++ 的桌面開發」（Desktop development with C++），保留 MSVC v143 x64/x86 工具與 Windows SDK。若已安裝 VS 2022，可用 Installer 修改工作負載。
2. **Git for Windows**：https://git-scm.com/downloads/win 。安裝時允許命令列使用 Git。
3. **Python 3.12（64 位元）**：https://www.python.org/downloads/windows/ 。安裝 Python launcher（`py`）；可勾選 Add Python to PATH。

CMake 與 Ninja 將由建置腳本安裝到專案的 Python 虛擬環境，不必另裝。Windows 不需要 Mono。

## 2. 解壓原始碼

將 `openDAQ-windows-source.zip` 解壓到簡短路徑，例如 `C:\DAQ`，確認下列檔案存在：

```
C:\DAQ\openDAQ\CMakeLists.txt
C:\DAQ\openDAQ\examples\applications\daq_web\build_windows.cmd
```

避免將專案放在 OneDrive 同步目錄或很深的路徑，以減少檔案鎖定與 Windows 路徑長度問題。初次建置需要網際網路下載 SDK 相依套件；請保持網際網路連線，並讓乙太網路保持連到 Digibox。

## 3. 建置

在開始功能表搜尋並開啟 **x64 Native Tools Command Prompt for VS 2022**。這一步請使用該命令提示字元，而不是一般 PowerShell 或直接雙擊建置腳本。

輸入：

```bat
cd /d C:\DAQ\openDAQ
examples\applications\daq_web\build_windows.cmd
```

腳本會檢查 C++、Git、Python，建立隔離的工具環境，安裝 CMake 3.31.10／Ninja 1.13.0，並編譯 SDK bridge、Native／OPC UA／WebSocket 客戶端與參考模組。依賴下載與 C++ 編譯可能需要一段時間；以最後出現 `Build succeeded` 為完成依據。

Windows 的 Boost 1.82.0 會先經原本的 SHA256 校驗，再使用 Python 的安全 tar 解壓縮功能，透過 `FETCHCONTENT_SOURCE_DIR_BOOST` 交給 CMake。若先前 CMake 已下載同一份 Boost 壓縮檔，腳本會重用該檔案，不必重新下載。

成功後應有：

```
build\daq-web\bin\daq_web_bridge.exe
```

若失敗，保留視窗，提供「第一個錯誤」及最後約 30 行訊息。不要停用 TLS、檔案 checksum 或修改 SDK 原始碼來略過建置錯誤。

### 舊版腳本：Boost `Invalid empty pathname`

若紀錄顯示 Boost 已下載、校驗完成，但 CMake 解壓縮出現 `archive_write_header(): Invalid empty pathname`，請在 repository 根目錄的開發者命令提示字元更新建置腳本後重跑：

```bat
curl.exe -fL https://raw.githubusercontent.com/PaGantw/openDAQ/daq-web-workstation/examples/applications/daq_web/build.py -o examples\applications\daq_web\build.py
examples\applications\daq_web\build_windows.cmd
```

只有第一行下載成功後再執行第二行。若 repository 權限阻止直接下載，可從 GitHub 分支下載新版 ZIP，取出其中的 `examples\applications\daq_web\build.py` 覆蓋舊檔。無需刪除整個 build 目錄或重新安裝 Visual Studio。ZIP 建置時 `not a git repository` 警告不會造成這個解壓縮錯誤。

## 4. 啟動工作台

在同一視窗輸入：

```bat
examples\applications\daq_web\start_windows.cmd
```

啟動後，保持視窗開啟，在此 Windows 電腦的瀏覽器輸入：

```
http://127.0.0.1:8080
```

日後可直接執行 `start_windows.cmd`，不必每次重新建置。若 TCP 8080 已被其他應用程式使用，可參閱 README 的 `server.py --port` 參數改用其他連接埠。

## 5. 測試 Digibox：169.254.27.27

1. 開啟工作台「裝置與連線」，按「掃描裝置」。`daqref://` 是參考裝置，請選擇 Digibox 的真實連線字串。
2. 若掃描不到，先確認 Windows 乙太網路網卡與 Digibox 的網段設定。`169.254.27.27` 是 link-local 位址，需要從直接連接的 Windows 電腦操作。可執行 `ipconfig` 檢查網卡位址，並以 `ping 169.254.27.27` 輔助檢查；有些設備不回應 ping。
3. 必要時使用手動連線。依 Digibox 實際啟用的協定選擇 Native 或 OPC UA，例如 `daq.nd://169.254.27.27` 或 `daq.opcua://169.254.27.27`；IP 不能用來推斷協定。若設備提供含 port／path 的字串，使用自訂模式完整貼上。
4. 設備需要登入時，展開「裝置登入」填入帳密，不要在聊天貼密碼。
5. 到「擷取與波形」先選一個訊號，開始擷取，確認筆數與波形更新。
6. 開始錄製，等待數秒後結束錄製，再到「組態與紀錄」下載 CSV。

若 Windows 防火牆詢問 SDK bridge 的網路存取，依實際網路設定允許它在設備所在網路通訊，不必關閉整個防火牆。網路探索通常需要同網段的 multicast；掃描失敗不代表直接連線一定失敗。

錄製檔位於 `build\daq-web\recordings`。工作台是單人本機應用程式，沒有多使用者登入服務。支援範圍、高速擷取及同步限制詳見 [README.md](README.md)。
