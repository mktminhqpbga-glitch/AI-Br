# Bàn giao cho AI tiếp nhận — AI-Br 0.7.0

Bàn giao ngày 18/11/2026 theo giờ Việt Nam. Repo đích là `mktminhqpbga-glitch/AI-Br`. Workspace là `/workspace/AI-Br`.

Mã cloud, dashboard, extension và API media đã có trong workspace. Kiểm thử tích hợp dùng dữ liệu giả. Triển khai Render và nghiệm thu bằng Chrome, tài khoản AI và kho đối tượng thật đang chờ quyền và cấu hình.

## 1. Việc AI tiếp nhận cần biết trước khi mở mã

- Nhánh phát hành của AI-Br là `main`. Commit `cb341f2` là mốc sau khi nhập lịch sử từ `RenZekta/AI-Bridge`, trước khi triển khai API media và Cloud Control Center. Khi tiếp nhận bản 0.7, xác nhận có các tệp trong danh sách bên dưới. Phần sửa adapter ToonFlow nằm ở repo `ToonFlow-App` riêng.
- Trước khi sửa, chạy `git status --short --branch` và xác nhận có `cloud-control.mjs`, `media-bridge.mjs`, `cloud-ui/`, `Dockerfile`, `render.yaml` và `package-lock.json`. Dùng các tệp này làm điểm tiếp tục.
- Giữ repo AI-Br độc lập. MacFlow/Toonflow chỉ tiêu thụ API có xác thực. Việc sửa adapter MacFlow cần xác nhận phạm vi riêng. Giữ phiên bản local, lịch sử Git và dự án nguồn. Việc xuất bản mã hoặc triển khai có chi phí cần quyền tương ứng.
- Dùng fixture khi kiểm thử tự động. Tách riêng việc gửi prompt có thể dùng hạn mức trên tài khoản thật. Nhập bí mật trong hệ thống cấu hình được cấp quyền, tránh đưa mật khẩu, API key, token thiết bị và thông tin S3 vào chat, Git, nhật ký hoặc báo cáo.

## 2. Kiến trúc và phân vai

```text
MacFlow / Toonflow ── HTTPS + API key ──> Node.js AI-Br trên Render
                                         │ Dashboard + định tuyến + hàng đợi
                                         │ Persistent disk + S3 riêng
                                         │
Chrome của người dùng ── WSS chủ động ────┘
         │
   Extension → đúng Chrome Profile, tab và tài liệu → trang AI đã đăng nhập
```

- **Local** là chế độ mặc định. Bind loopback, cổng chính `4319`, cổng tương thích `4317` khi không đặt cổng riêng. `BRIDGE_API_KEY` bật xác thực cho model, status và media. Tiện ích local dùng token từ `.ai-bridge-token`. Chat cũ vẫn có đường xử lý riêng và hỗ trợ SSE.
- **Cloud** dùng `BRIDGE_MODE=cloud`. Node bind `0.0.0.0:$PORT`, mặc định `10000`, bên trong Render. Render kết thúc HTTPS/WSS. Gateway ngoài `/health` kiểm tra hostname và `X-Forwarded-Proto: https`. Nếu tự host, dùng reverse proxy tin cậy ghi đè các header này, giữ upstream riêng. Browser do người dùng chạy, container production chỉ chứa gateway, dashboard, FFmpeg và công cụ đóng gói.
- Triển khai một instance. Persistent disk `/var/data/ai-bridge` giữ cấu hình, bản ghi tác vụ/idempotency, sự kiện, metadata và bản ảnh tham chiếu phục vụ điều phối. Kho S3 riêng giữ đối tượng ảnh/video. Node xác minh bytes trước khi lưu và đối chiếu lại checksum khi tải. Mặc định quota media 2 GiB, thời hạn 168 giờ, thống kê sự kiện 30 ngày. Thiết lập lifecycle bucket cho cùng prefix để thu dọn cả đối tượng mồ côi.

## 3. Bản đồ mã nguồn

| Tệp hoặc thư mục | Trách nhiệm |
| --- | --- |
| [local-server.mjs](../local-server.mjs) | Entry point, HTTP, legacy chat, bootstrap local/cloud, WSS, routing theo scope, chuyển đổi ảnh/video và SSE. Xem `initializeMediaBridge` và `handleCloudHttp`. |
| [media-bridge.mjs](../media-bridge.mjs) | Hàng đợi, kiểm tra target và khả năng, chống gửi trùng, task recovery, điều phối frame media, trạng thái terminal, trả kết quả. |
| [media-store.mjs](../media-store.mjs) | Giới hạn, chữ ký định dạng, giải mã qua `ffprobe` và `ffmpeg`, SHA-256, metadata/quota/TTL. |
| [cloud-objects.mjs](../cloud-objects.mjs) | S3 client, request ký bằng SigV4, lưu/đọc/xóa qua endpoint HTTPS private. |
| [cloud-control.mjs](../cloud-control.mjs) | Phiên quản trị, CSRF, API key theo scope, pairing, hồ sơ Chrome, kiểm tra domain, chính sách model, lưu sự kiện và số liệu, đóng gói extension. |
| [cloud-ui/](../cloud-ui/) | Dashboard tiếng Việt, bộ lọc, timeline và báo cáo đã ẩn dữ liệu nhạy cảm. OpenAPI được phục vụ tại `/openapi.json`. |
| [extension/background.js](../extension/background.js) | Profile UUID, pairing HTTP, reconnect WSS, heartbeat, inventory, kiểm tra document, xử lý cấu hình và chuyển frame. |
| [extension/content.js](../extension/content.js), [extension/media-adapters.js](../extension/media-adapters.js) | Quan sát DOM, xác nhận ảnh đính kèm trước khi gửi, nhận diện prompt được website tiếp nhận và thu kết quả mới. |
| [render.yaml](../render.yaml), [Dockerfile](../Dockerfile), [docker-start.mjs](../docker-start.mjs) | Blueprint một dịch vụ, đĩa bền vững, image Node 22 có FFmpeg. Bootstrap cấp quyền thư mục mount và hạ quyền xuống UID 1000 trước khi chạy gateway. |
| [test/](../test/), [integration/browser.mjs](../integration/browser.mjs) | Regression local, HTTP/HTTPS/WSS, task, storage giả lập, dashboard Chromium và fixture DOM cho extension. |

## 4. Hợp đồng API và cách tích hợp

Dùng `https://<hostname>/v1` làm Base URL cloud. Tạo key riêng qua dashboard. Scope `read` dò model, inventory, tác vụ. `generate` gửi hoặc hủy tác vụ còn chờ. `upload` tải ảnh tham chiếu. `download` lấy bytes, kể cả `b64_json`. Tác vụ, ảnh tham chiếu và tệp kết quả thuộc API key đã tạo. Mã pairing có hiệu lực 10 phút, dùng một lần. Phiên quản trị, mã pairing, thông tin xác thực thiết bị và API key có mục đích riêng.

| Endpoint | Diễn giải |
| --- | --- |
| `GET /health` | Kiểm tra tiến trình. |
| `GET /api/bridge/status`, `GET /v1/models` | Dò Profile/tab/phiên và model đã bật. Khả năng công bố là giao chính sách cấu hình và năng lực tab được báo cáo. |
| `POST /v1/chat/completions` | Chat OpenAI-compatible với lựa chọn `media_kind`, `target` và `input_images`. Kết quả media ở mảng cấp cao nhất. SSE cloud dành cho văn bản và hiện phát nội dung sau khi bridge thu câu trả lời hoàn chỉnh. |
| `POST /v1/images/generations` | Ảnh đồng bộ, `n=1`, hỗ trợ `url` hoặc `b64_json`. URL là endpoint AI-Br cần Bearer key. |
| `POST /v1/videos`, `GET /v1/videos/{task_id}` | Tạo và tra cứu video bất đồng bộ. |
| `POST /v1/media/tasks`, `GET /v1/media/tasks/{task_id}` | Tạo và tra cứu tác vụ bằng hợp đồng media. `DELETE` hủy tác vụ còn chờ. |
| `POST /v1/input-images`, `GET /v1/media/{id}` | Nhận bytes PNG/JPEG/WebP và trả UUID kèm MIME, kích thước, SHA-256. Trả bytes kết quả đã xác minh với `Cache-Control: private, no-store`. |

**Luồng MacFlow đề xuất:** Lấy model và status. Chọn tab `ready`, chưa `busy` và hỗ trợ loại mong muốn. Upload ảnh tham chiếu, giữ thứ tự UUID. Lưu payload và `client_request_id` trước khi POST. Sau đó lưu `task_id`, poll đến trạng thái cuối, tải bytes với cùng key và xác minh MIME, kích thước, SHA-256 trước khi gắn vào node.

```json
{
  "client_request_id": "run-348-node-7-attempt-1",
  "model": "bridge-image",
  "stream": false,
  "media_kind": "image",
  "target": {
    "profileInstanceId": "2671ef2a-a9a1-4687-a7a4-aebbd22afd43",
    "tabId": 42,
    "documentToken": "82d07aa6-44fd-49d7-ab08-c1a95a8d54eb",
    "url": "https://chatgpt.com/c/example"
  },
  "messages": [{"role":"user","content":"Tạo ảnh phong cảnh từ ảnh tham chiếu."}],
  "input_images": ["780fa6e8-0db3-4d25-8c21-6296f4c2f51c"]
}
```

Các giá trị model, tab và ID ở trên là ví dụ. `target` dùng nguyên bốn trường từ status. Có thể bỏ target trên cloud nếu quản trị viên đã ghim model vào một phiên cụ thể. Khi tải lại, chọn đúng `documentToken` mới. Giới hạn ảnh đầu vào 5 MiB mỗi ảnh, tối đa 4 ảnh và 16 MiB gộp. Kết quả tối đa 4 tệp, mỗi tệp 16 MiB, với PNG, JPEG, WebP, MP4 hoặc WebM hợp lệ.

### Điều phối và an toàn tác vụ

- Chuỗi kiểm tra chính gồm policy của model, đúng Profile/tab/document/URL/provider, sẵn sàng, không bận, đủ khả năng media, ảnh tham chiếu hợp lệ. Extension kiểm tra lại đúng tab và xác nhận từng ảnh trong composer trước khi xin `bridge:permit`.
- ID chống gửi trùng trên cloud dùng `client_request_id` hoặc `Idempotency-Key`, theo từng API key. Tạo async lần đầu trả 202. Cùng khóa và cùng payload trả tác vụ cũ. Khác payload trả 409. Với sync, lần thử lại khi đang chạy trả `TASK_IN_PROGRESS` và `X-Task-Id`.
- Các trạng thái gồm `queued`, `running`, `completed`, `failed`, `cancelled`, `unknown`. Khi mất WSS hoặc hết thời gian và website có thể đã nhận prompt, giữ `unknown` và không phát lại prompt. Khi tiến trình khởi động lại, tác vụ đang chạy chuyển `unknown`, tác vụ chờ chuyển `cancelled`. Phiên tài liệu chưa rõ kết quả vẫn bị khóa theo định danh hiện có.
- Khi sync có tệp, chỉ thành công sau khi có metadata của media hợp lệ. Download bảo toàn MIME, checksum và phạm vi khóa. Nếu media hết hạn, metadata tác vụ có thể còn nhưng tệp không còn khả dụng.
- Sử dụng `request_id`, `trace_id`, `task_id` và các header `X-Request-Id`, `X-Trace-Id`, `X-Task-Id` để tra tầng lỗi. Dashboard phân biệt gateway tiếp nhận, auth, dispatch, extension nhận, phát hiện website nhận prompt, site hoàn tất, media tới server, lưu và trả. Poll lại không tăng số tác vụ hoàn thành hoặc đã trả kết quả. Sự kiện tác vụ không chứa prompt hoặc khóa.

## 5. Kiểm thử và tái lập

Trong `/workspace/AI-Br`, dùng Node.js 22.4+ cho kiểm thử, FFmpeg/ffprobe, OpenSSL và zip/unzip. Cài theo lockfile bằng `npm ci`. Chromium là điều kiện để chạy các bài UI/DOM. `CHROME_BIN` có thể chỉ định executable.

```sh
npm ci
BRIDGE_TEST_DASHBOARD=1 npm test
npm run test:browser
docker build -t ai-bridge-cloud .
```

| Kiểm tra | Bằng chứng và phạm vi |
| --- | --- |
| API + dashboard | 26 bài PASS gồm hồi quy local, HTTPS reverse proxy, WSS, S3 API fixture, quyền API, model/capability, ảnh/video, SSE, ngắt kết nối và recovery. Bật cờ dashboard để thực thi luồng trình duyệt. |
| Extension + DOM | 1 bài PASS trong Chromium. Content script chạy trên DOM fixture, background dùng Chrome API mô phỏng. Kiểm tra chọn tab, F5, ảnh trước submit, upload PNG/video và chặn gửi khi thiếu xác nhận đính kèm. Chính sách môi trường quản lý chặn nạp extension unpacked thật. |
| Docker | Lần triển khai trong workspace đã build PASS từ cache tải theo lockfile do build online gặp lỗi registry trong container. Container chạy UID 1000 với volume ghi được, qua `/health`, dashboard và xác thực `/v1/models`. Có thể truyền cache đã nạp bằng `--build-context npm_cache=/đường/dẫn/cache`. |
| Tài liệu | Render YAML đã parse và tham chiếu OpenAPI đã được kiểm tra. Việc Render chấp nhận và provision Blueprint trên tài khoản thật vẫn cần xác nhận. |

Trong container CI cần thiết, chạy `CHROME_NO_SANDBOX=1 npm run test:browser` cho riêng fixture. Các lượt trên không sử dụng hạn mức AI thật.

## 6. Phần còn phải nghiệm thu và thứ tự tiếp tục

1. **Quyền và cấu hình Render.** Cần quyền tạo Web Service, hostname HTTPS chuẩn và bucket S3 riêng với quyền get/put/delete theo prefix. Nhập `BRIDGE_PUBLIC_URL`, `BRIDGE_ADMIN_PASSWORD` và các biến `BRIDGE_S3_*` qua giao diện secret. Blueprint chọn một instance Starter và persistent disk 10 GB. Kiểm tra giá trong tài khoản trước khi triển khai.
2. **Smoke test cloud thật, không phát sinh yêu cầu tạo media.** Kiểm tra TLS, `/health`, vào dashboard, tạo mã dùng một lần, tải gói extension và nạp thủ công lên Chrome của người dùng. Xác minh pairing, reconnect, heartbeat, mô hình quyền hạn và inventory tab. Dùng một máy khác gọi model/status với Bearer đúng scope. Nếu có domain riêng, kiểm tra Render TLS và DNS TXT/CNAME theo hướng dẫn triển khai.
3. **Tích hợp job và khôi phục.** Trên endpoint thật, kiểm tra lỗi stale/busy, cách MacFlow giữ `client_request_id` và `task_id`, cùng khả năng poll sau restart. Khi cần thử media thật, xin quyền sử dụng hạn mức, chạy mẫu nhỏ và kiểm tra tải bytes, MIME/SHA-256 và trace xuyên suốt.
4. **Giới hạn live adapter.** Adapter ảnh hiện nhắm ChatGPT khi nhận diện chế độ tạo ảnh. Adapter video nhắm Grok Imagine khi nhận diện điều khiển phù hợp. Chưa có bằng chứng live cho hai adapter. Muse, video từ ảnh, thời lượng và độ phân giải cần adapter và kiểm chứng riêng trước khi bật. MCP từ xa là phần bổ sung tùy chọn, hiện dashboard và giao diện ứng dụng dùng API HTTP đã tài liệu hóa.
5. **Giữ đúng giới hạn vận hành.** Mô hình hiện tại là một tiến trình với disk và object store chuyên dụng. Kiểm thử tải và phương án backup/recovery production nên được xác nhận trước khi tăng quy mô.

## Nguồn để đọc tiếp

- [Hướng dẫn Render, biến môi trường và PASS/FAIL](cloud-render.md)
- [Hợp đồng media MacFlow/Toonflow bản local](macflow-api.md)
- [OpenAPI 3.1 cho chế độ cloud](../cloud-ui/openapi.json)
- [Blueprint Render](../render.yaml)
