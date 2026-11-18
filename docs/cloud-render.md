# AI Bridge Cloud trên Render

Gateway AI Bridge Cloud chạy trên một Render Web Service. Bảng cập nhật có thể chạy trên dịch vụ Render riêng. HTTPS phục vụ dashboard và API, WSS nhận kết nối chủ động từ tiện ích trên Chrome của người dùng. Gateway điều phối tác vụ và lưu trạng thái trên persistent disk hoặc PostgreSQL, tùy Blueprint. Chrome dùng phiên AI mà người dùng đã đăng nhập. MacFlow chỉ cần địa chỉ API và Bearer key.

```text
MacFlow / Toonflow ─── HTTPS ──> AI Bridge trên Render <── WSS ── Chrome Extension
                                     │                              │
                           Disk hoặc PostgreSQL + kho S3 riêng       └── tab AI
```

## Cấu hình Render

Các bước dưới đây dùng Blueprint có persistent disk. Với Web Service miễn phí, dùng cấu hình trong mục [Render Free](#render-free).

1. Chuẩn bị một bucket S3 hoặc S3-compatible riêng tư. Chặn truy cập công khai. Cấp quyền đọc, ghi và xóa đối tượng cho riêng prefix của dịch vụ. Dùng endpoint HTTPS kiểu path-style được nhà cung cấp hỗ trợ. Cấu hình lifecycle bucket cho đúng prefix ở mốc dự phòng dài hơn TTL của ứng dụng, ví dụ 2 ngày với mặc định 24 giờ. Lifecycle thu dọn cả đối tượng bị bỏ lại khi tiến trình dừng giữa lúc upload và ghi metadata.
2. Trong tài khoản Render được cấp quyền, tạo Blueprint từ `render.yaml`. Cấu hình dùng Docker và một instance có persistent disk tại `/var/data/ai-bridge`. Disk giữ file trạng thái, nhật ký, thông tin ghép thiết bị dạng hash, metadata và bản ảnh đầu vào phục vụ hàng đợi. Kho đối tượng riêng lưu cả ảnh đầu vào và media đầu ra. Mỗi deployment dùng một disk riêng, một bucket hoặc prefix riêng, và đúng một instance để bảo toàn idempotency.
3. Điền biến trong Render. Gán `BRIDGE_PUBLIC_URL` bằng origin HTTPS Render cấp, chẳng hạn `https://ai-bridge-cloud.onrender.com`. Đặt mật khẩu quản trị ngẫu nhiên dài ít nhất 24 ký tự. Nhập thông tin kho S3 trong giao diện secret của Render.
4. Deploy và mở URL HTTPS. Kiểm tra `GET /health` rồi đăng nhập dashboard. Render kết thúc TLS và chuyển tiếp Host cùng `X-Forwarded-Proto: https`. WSS cũng kiểm tra các header này. Khi tự host, đặt ứng dụng sau reverse proxy tin cậy ghi đè các header này và giữ cổng upstream riêng.

| Biến | Giá trị |
| --- | --- |
| `BRIDGE_MODE` | `cloud` |
| `PORT` | Render cấp, mặc định 10000 |
| `BRIDGE_PUBLIC_URL` | Origin HTTPS chính trên `.onrender.com`, không dấu gạch chéo cuối |
| `BRIDGE_ADMIN_PASSWORD` | Mật khẩu quản trị |
| `BRIDGE_DATA_DIR` | Đường dẫn disk bền vững, mặc định trong Docker là `/var/data/ai-bridge` |
| `BRIDGE_S3_ENDPOINT`, `BRIDGE_S3_BUCKET`, `BRIDGE_S3_REGION` | Cấu hình bucket và vùng, dùng `auto` nếu nhà cung cấp yêu cầu |
| `BRIDGE_S3_ACCESS_KEY_ID`, `BRIDGE_S3_SECRET_ACCESS_KEY` | Khóa quyền tối thiểu dành riêng cho bucket/prefix |
| `BRIDGE_S3_PREFIX` | Mặc định `ai-br` cho Starter và `ai-br-free` trong Blueprint Free |
| `BRIDGE_MEDIA_QUOTA_BYTES` | Mặc định 7 GiB (`7516192768` byte), tính cả ảnh đầu vào và đầu ra |
| `BRIDGE_MEDIA_RETENTION_HOURS` | Mặc định 24 giờ |

Ứng dụng dọn media hết hạn và xóa các tệp cũ nhất có thể xóa khi dung lượng vượt 70% quota (khoảng 4,9 GiB với cấu hình mặc định) hoặc một lượt lưu mới sẽ đẩy dung lượng vượt mốc này. Tệp tham chiếu của tác vụ đang chờ/chạy và media đang lưu hoặc đọc từ kho được bảo vệ. Nếu phần đang sử dụng vượt ngưỡng dọn, ứng dụng tiếp tục giữ các tệp đó trong giới hạn quota. Chỉ khi thật sự thiếu chỗ ở quota cứng mới trả HTTP 507. Tệp đã dọn sẽ không tải lại được. Cập nhật các biến `BRIDGE_MEDIA_QUOTA_BYTES` và `BRIDGE_MEDIA_RETENTION_HOURS` trên dịch vụ Render hiện có nếu chúng vẫn dùng giá trị cũ. Sự kiện chẩn đoán dùng cửa sổ 30 ngày. Metadata tác vụ và khóa chống gửi trùng được giữ trên disk để việc tra cứu tiếp tục hoạt động sau restart. Khi cần chuyển dịch vụ, giữ disk và kho đối tượng tương ứng. Dùng các thủ tục backup của Render và kho đã chọn.

Để thêm domain riêng, thêm hostname vào Render, cấu hình CNAME trỏ đúng hostname `.onrender.com` của gateway và chờ Render cấp TLS. Trong **Cấu hình API → Tên miền riêng**, tạo challenge, thêm TXT `_aibr-verify.<hostname>` với giá trị hiển thị và bấm xác minh. Sau đó có thể dùng domain đó cho API và làm địa chỉ mặc định khi tải gói tiện ích. Dashboard xác minh TXT và CNAME. Render cấp chứng chỉ. Cấu hình **Origin được phép** riêng cho các frontend cần CORS. Backend MacFlow gọi trực tiếp không cần thêm origin.

## Render Free

1. Chuẩn bị bucket Backblaze B2 riêng tư hoặc một kho S3-compatible khác. Chuẩn bị PostgreSQL bên ngoài Web Service có TLS và còn hoạt động lâu dài, chẳng hạn một database trên Neon. Tài khoản database cần quyền tạo bảng trong schema của ứng dụng. PostgreSQL trên gói Free của Render tự hết hạn sau 30 ngày. [Giới hạn Free của Render](https://render.com/docs/free)
2. Tạo Blueprint từ cùng repo và đặt **Blueprint Path** thành `render-free.yaml`. Điền URL kết nối trực tiếp tới PostgreSQL vào secret `BRIDGE_STATE_DATABASE_URL`. Điền các biến S3, mật khẩu quản trị và `BRIDGE_PUBLIC_URL` như mục trên. Blueprint chọn `plan: free`, đặt `BRIDGE_STATE_MODE=postgres` và dùng `/tmp/ai-bridge` làm thư mục tạm. Cấp quyền đọc, ghi và xóa đối tượng cho prefix `ai-br-free`.
3. Sau khi deploy, vào `/health`, đăng nhập dashboard và ghép Chrome. Đặt Base URL của MacFlow thành `https://<hostname>/v1`, rồi cấp Bearer key từ dashboard như ở mục kết nối bên dưới.
4. Nếu cần cập nhật từ web, tạo Blueprint riêng từ `render-updater-free.yaml`. Dùng cùng database hoặc database riêng. Điền `BRIDGE_STATE_DATABASE_URL` và các biến dành cho updater ở mục tiếp theo. Gán `BRIDGE_UPDATER_TARGET_SERVICE_ID` bằng ID gateway Free và gán `BRIDGE_UPDATE_URL` trên gateway bằng URL HTTPS của updater.

PostgreSQL giữ cấu hình model, thông tin ghép Chrome, API key dạng hash, tác vụ, nhật ký và metadata media. Ảnh đầu vào được đọc từ bucket khi cần gửi sang Chrome. Ảnh và video đầu ra cũng nằm trong bucket, với cùng quota 7 GiB, TTL 24 giờ và quy tắc dọn ở 70%. Khi dịch vụ ngủ, dọn nền sẽ tiếp tục lúc thức dậy. Đặt lifecycle cho prefix của bucket để thu dọn tệp bị bỏ lại sau TTL của gateway. Nếu B2 giữ phiên bản cũ hoặc ẩn, cấu hình lifecycle loại bỏ chúng để hạn chế dung lượng tính trên B2.

Database có thể dùng chung với updater vì hai dịch vụ dùng không gian dữ liệu riêng. Mặc định không gian này dựa trên `RENDER_SERVICE_ID`, nên deploy lại cùng Web Service sẽ đọc đúng trạng thái trước đó. Khi tự host hoặc cần giữ trạng thái qua việc thay thế một Web Service đã chạy với PostgreSQL, có thể đặt `BRIDGE_STATE_NAMESPACE` ổn định. Dùng một gateway hoạt động cho mỗi không gian dữ liệu và dùng prefix B2 riêng cho mỗi gateway. Nếu đang dùng Blueprint có disk, trạng thái cũ vẫn nằm trên disk và chưa tự chuyển sang PostgreSQL. Gateway Free trên một database mới cần thiết lập model, ghép Chrome và cấp key lại.

Render Free có thể ngủ sau 15 phút không có lưu lượng đến. Yêu cầu tiếp theo có thể chờ khởi động và tiện ích Chrome cần kết nối lại. Khi gateway khởi động lại, các tác vụ đang chạy chuyển sang `unknown` và gateway giữ khóa chống gửi lại prompt. Phiên đăng nhập dashboard có thể yêu cầu đăng nhập lại. Gateway và updater Free tính giờ chạy vào cùng hạn mức của workspace. Chrome trên máy người dùng vẫn cần chạy và đăng nhập tab AI để xử lý tác vụ. [Giới hạn Free của Render](https://render.com/docs/free)

## Cập nhật gateway từ web

Thiết lập gateway trước để có bản deploy đang chạy làm mốc. Tạo Web Service cập nhật riêng bằng [render-updater.yaml](../render-updater.yaml) nếu dùng persistent disk, hoặc [render-updater-free.yaml](../render-updater-free.yaml) nếu dùng PostgreSQL trên Render Free. Cả hai dùng [Dockerfile.updater](../Dockerfile.updater) và tắt Auto-Deploy.

Điền các biến sau cho **dịch vụ cập nhật**:

| Biến | Giá trị |
| --- | --- |
| `BRIDGE_UPDATER_PUBLIC_URL` | Origin HTTPS của dịch vụ cập nhật |
| `BRIDGE_UPDATER_TARGET_SERVICE_ID` | ID `srv-...` của **gateway** cần cập nhật |
| `BRIDGE_UPDATER_RENDER_KEY` | API key Render của workspace được quyền đọc và deploy gateway |
| `BRIDGE_UPDATER_PASSWORD` | Mật khẩu riêng của mục cập nhật, ít nhất 24 ký tự |
| `BRIDGE_UPDATER_TARGET_REPO`, `BRIDGE_UPDATER_TARGET_BRANCH` | Repo và nhánh mà gateway đã liên kết. Blueprint đặt mặc định `mktminhqpbga-glitch/AI-Br`, nhánh `main` |
| `BRIDGE_UPDATER_GITHUB_TOKEN` | Chỉ đặt nếu repo riêng tư. Dùng token chỉ đọc nội dung repo |

Render cung cấp `RENDER_SERVICE_ID` cho chính updater để ứng dụng chặn tự deploy. Tắt **Auto-Deploy** ở gateway để mỗi lần cập nhật dùng commit đã được xác nhận. Trên gateway, đặt `BRIDGE_UPDATE_URL` thành origin HTTPS của updater. Mục **Cập nhật** trên dashboard sẽ mở dịch vụ độc lập này. Có thể lưu URL updater để tiếp tục theo dõi khi gateway đang khởi động.

Mở updater, đăng nhập bằng mật khẩu riêng, xem commit đang chạy và commit mới nhất, rồi mở diff GitHub nếu cần. Khi bấm **Triển khai commit mới**, ứng dụng xác minh lại repo, nhánh, lịch sử Git nối tiếp và trạng thái Render. Render build đúng SHA đã duyệt. Nếu commit thay đổi trong lúc xem trước hoặc đang có deploy khác, updater yêu cầu kiểm tra lại. Nếu mất phản hồi sau khi bấm, mục này giữ bản ghi và tra lại deploy trước khi cho phép gửi tiếp.

Các lần cập nhật này áp dụng cho gateway. Updater giữ URL, tiến trình và lịch sử riêng. Render có thể ngắt ngắn kết nối gateway trong lúc thay phiên bản. Chọn lúc không có tác vụ đang chạy. Gateway đọc lại trạng thái từ disk hoặc PostgreSQL và tiếp tục dùng cùng kho đối tượng sau khi khởi động lại.

## Ghép Chrome và cấu hình model

1. Vào **Chrome và tiện ích**, tải gói, giải nén rồi tự nạp thư mục `extension` bằng **Load unpacked**. Tạo mã ghép nối mới, có hiệu lực 10 phút và dùng một lần.
2. Mở popup, xác nhận URL HTTPS và nhập mã. Tiện ích lưu thông tin kết nối trong vùng lưu trữ Chrome dành cho ngữ cảnh tin cậy. Khi ghép xong, tiện ích tự kết nối lại, gửi inventory và nhận model đã cấu hình. Chỉ mở và đăng nhập tab AI bằng Chrome của người dùng.
3. Tại **AI và model**, đặt ID API, chọn adapter và khả năng được phép, rồi ghim đúng Profile, tab và phiên tài liệu nếu client sẽ gọi không có `target`. Nếu để MacFlow chọn đích, gửi cả bốn trường trong `target` lấy từ status. Khi reload hoặc đổi phiên, chọn lại phiên. Khi tab bận hoặc offline, gateway trả lỗi và giữ nguyên đích.
4. Tab tạo ảnh hoặc video cần báo đúng loại trong `outputKinds`. Bản này dùng adapter ảnh ChatGPT và video Grok Imagine khi nhận diện được chế độ phù hợp, cùng các adapter văn bản hiện có. API loại bỏ khả năng mà quản trị viên chưa bật. Ảnh tham chiếu được kiểm tra lại trong trình soạn thảo trước khi bấm gửi. Chỉ lựa chọn được nhà cung cấp có adapter tích hợp. Muse, thời lượng, độ phân giải và cấu hình video từ ảnh cần adapter tương ứng để có thể công bố. Các trường tạo media không hỗ trợ bị từ chối.
5. Trong **Cấu hình API**, tạo key riêng cho MacFlow với các quyền cần dùng. **read** đọc model, status và tác vụ, **generate** gửi tác vụ hoặc hủy tác vụ còn chờ, **upload** tải ảnh tham chiếu, **download** tải bytes kết quả. Các tài nguyên tác vụ và media thuộc riêng key đã tạo chúng. Mật khẩu quản trị, phiên quản trị, mã ghép nối, thông tin thiết bị và API key dùng cho các mục đích tách biệt.

## Kết nối MacFlow

Đặt Base URL là `https://<hostname>/v1`, đặt Bearer key theo cấu hình và dùng ID model đúng như `GET /v1/models`. Tra cứu `GET /api/bridge/status` để chọn phiên. [OpenAPI với ví dụ request/response](../cloud-ui/openapi.json) cũng phục vụ tại `/openapi.json`.

| Endpoint | Cách dùng |
| --- | --- |
| `GET /health` | Kiểm tra tiến trình, không gọi AI. |
| `GET /api/bridge/status`, `GET /v1/models` | Dò tab và khả năng thực tế, không gọi AI. |
| `POST /v1/chat/completions` | Đầu ra OpenAI Chat Completions, có thể kèm mảng `media`. Chat text `stream: true` dùng SSE, nội dung được gửi sau khi bridge nhận câu trả lời hoàn chỉnh. |
| `POST /v1/images/generations` | Tạo một ảnh với `model`, `prompt`, `target` nếu chưa ghim, và `input_images` nếu có. `response_format` là `url` hoặc `b64_json`. Link URL trỏ vào media API. Cả tải URL lẫn nhận `b64_json` đều cần quyền `download`. |
| `POST /v1/videos`, `GET /v1/videos/{task_id}` | Gửi video bất đồng bộ và lấy trạng thái. Mảng `media` có sau khi xác minh xong. |
| `POST /v1/media/tasks`, `GET /v1/media/tasks/{task_id}` | Giao thức tác vụ cho hội thoại, ảnh hoặc video dùng `media_kind`. `DELETE` chỉ hủy khi tác vụ còn trong hàng đợi. |
| `POST /v1/input-images`, `GET /v1/media/{id}` | Upload bytes ảnh và download bytes đã xác minh. Các giới hạn định dạng và kích thước vẫn theo hợp đồng [API MacFlow](macflow-api.md). |

Mọi yêu cầu tạo tác vụ cloud cần `client_request_id` hoặc header `Idempotency-Key`. Lưu khóa này cùng payload trước khi gửi. Nếu mất phản hồi trước khi nhận task ID, dùng lại khóa và đúng payload. Khi đã có task ID, tra cứu trạng thái. Phản hồi sync cho yêu cầu đang thực hiện là HTTP 409 `TASK_IN_PROGRESS` cùng `X-Task-Id`. Lần gửi sync trùng sau khi hoàn thành trả kết quả đã lưu. Tác vụ async trả HTTP 202 khi tạo mới và HTTP 200 khi đọc lại qua cùng khóa. Tác vụ đang chạy trước khi dịch vụ dừng chuyển thành `unknown`. Tác vụ còn chờ chuyển thành `cancelled`. Gateway không tự gửi lại prompt đã có thể tới website. Quy trình polling và download dùng key ban đầu.

Mỗi tác vụ giữ `request_id`, `trace_id` và `task_id`. HTTP cũng có các header `X-Request-Id`, `X-Trace-Id` và `X-Task-Id` khi đã có task. Dashboard dùng timeline để phân biệt gửi tới tiện ích, tiện ích nhận, phát hiện website nhận prompt, website phản hồi, upload media, lưu và trả kết quả. Bộ đếm giao nhận dùng các cột mốc bền vững theo từng tác vụ. Poll lại không tăng số tác vụ hoàn thành hoặc số tác vụ đã trả kết quả. Nút sao chép chẩn đoán loại URL của tab và ID tùy đặt phía ứng dụng. AI Bridge loại nội dung prompt và thông tin xác thực khỏi nhật ký.

## Kiểm thử và nghiệm thu riêng

Dùng Node.js 22.4 trở lên, FFmpeg, ffprobe, OpenSSL, zip/unzip.

```sh
npm ci
npm test
BRIDGE_TEST_DASHBOARD=1 node --test test/cloud.test.mjs
npm run test:browser
docker build -t ai-bridge-cloud .
```

Bộ cloud dựng reverse proxy HTTPS, kết nối WSS và kho tương thích giao thức S3 giả lập. Cờ `BRIDGE_TEST_DASHBOARD=1` mở dashboard trong Chromium để xác minh đăng nhập và các thao tác giao diện. Để chạy cùng kiểm thử với Blueprint Free, đặt `BRIDGE_TEST_STATE_DATABASE_URL` bằng URL của PostgreSQL dành riêng cho kiểm thử, có TLS. `CHROME_BIN` trỏ tới Chromium khi máy dùng đường dẫn khác. Bộ trình duyệt chạy code tiện ích trên DOM giả lập qua Chrome API mô phỏng. Có thể đặt `CHROME_NO_SANDBOX=1` riêng cho bài thử trong container CI cần chế độ đó.

### Kết quả kiểm thử trong workspace

| Phần | Kết quả |
| --- | --- |
| API local, cloud và cập nhật | PASS, 31 bài. Đã kiểm thử scope, dashboard, WSS, tải media đúng SHA-256, dọn tệp cũ và bảo vệ tệp đang dùng, xác nhận commit và chặn gửi deploy trùng. GitHub và Render API trong các bài updater dùng mô phỏng. |
| Render Free với PostgreSQL | PASS, 32 bài. Dùng PostgreSQL 17 với TLS và kho S3 giả lập. Đã kiểm tra mất thư mục tạm, dùng lại key và ảnh tham chiếu, tải video, tra cứu tác vụ, lịch sử updater và chặn tiến trình cũ ghi đè. |
| Tiện ích và DOM | PASS, 1 bài Chromium với trang AI giả lập. Đã chạy code kiểm tra ảnh tham chiếu, đúng tab, F5, upload ảnh và video. Chrome API dùng mô phỏng. |
| Docker | PASS, build bằng cache npm nạp từ registry theo lockfile. Container chạy với UID 1000 và volume ghi được, phục vụ `/health`, dashboard và bảo vệ `/v1/models`. |
| Docker updater | PASS. Build và khởi động updater riêng với UID 1000 và disk riêng. Kiểm tra `/health`, giao diện và yêu cầu đăng nhập. |
| Blueprint và OpenAPI | PASS, YAML đọc được và mọi tham chiếu OpenAPI phân giải được. |
| Render, bucket, domain và tài khoản AI thật | Chờ nghiệm thu với tài khoản và cấu hình được cấp quyền. |

Bước nghiệm thu trên Render cần quyền tạo Web Service và một bucket riêng tư đã cấu hình. Sau khi có URL, xác nhận ghép Chrome thật, heartbeat, tab, API từ máy khác và khôi phục sau deploy lại. Việc gửi prompt tạo ảnh/video tới website thật là bước riêng có đồng ý sử dụng hạn mức.
