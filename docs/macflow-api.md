# API AI-Br cho MacFlow và Toonflow

AI-Br quản lý phiên Chrome, gửi prompt, giữ hàng đợi và lưu tệp. MacFlow gọi API HTTP với cùng một Bearer key để dò tab, tải ảnh tham chiếu, tạo tác vụ và lấy tệp kết quả.

## Khởi động và xác thực

1. Cài Node.js 20 trở lên, Chrome 116 trở lên và FFmpeg (`ffmpeg` và `ffprobe` có trong `PATH`).
2. Đặt `BRIDGE_API_KEY` trong môi trường chạy AI-Br và cấu hình cùng giá trị đó ở backend MacFlow. Chạy `npm start` tại thư mục AI-Br.
3. Nạp thư mục `extension` dưới dạng tiện ích unpacked. Ghép nối một lần mỗi Chrome Profile với `http://127.0.0.1:4319` và giá trị trong tệp cục bộ `.ai-bridge-token`. Dùng bản extension 0.6.0 trở lên có giao thức media 1.
4. Mở và đăng nhập các trang AI trong Chrome. Chọn tab và theo dõi tác vụ từ MacFlow qua các endpoint bên dưới.

API nghe tại `http://127.0.0.1:4319`. Bản mặc định giữ cổng `4317` làm địa chỉ tương thích, dùng cùng hàng đợi và bộ lưu trữ. Đặt `BRIDGE_PORT` nếu cần chạy trên một cổng cụ thể. MacFlow và tiến trình AI-Br cần truy cập được cùng loopback.

Gửi `Authorization: Bearer <API_KEY>` tới các endpoint trong tài liệu này. Bridge Token chỉ dùng trong kết nối WebSocket của tiện ích. Server in đường dẫn tệp token lúc khởi động. Tệp dữ liệu mặc định là thư mục `.ai-bridge-data/`; có thể đặt `BRIDGE_DATA_DIR` để dùng thư mục riêng. Mỗi thư mục dữ liệu dành cho một tiến trình AI-Br. Thư mục chứa prompt của tác vụ, ảnh đầu vào và tệp kết quả đã xác minh, nên cần có quyền truy cập cục bộ phù hợp. ID vẫn dùng được sau khi khởi động lại nếu dữ liệu được giữ lại.

## 1. Dò khả năng và chọn tab

`GET /api/bridge/status`

Ví dụ phản hồi của một profile có tab ChatGPT ở chế độ tạo ảnh. Danh sách `providers` thực tế chứa tất cả ID mà phiên bản AI-Br nhận diện.

```json
{
  "connected_extensions": 1,
  "extension_versions": ["0.6.0"],
  "providers": [
    {"id": "grok", "label": "Grok"},
    {"id": "gemini", "label": "Gemini"},
    {"id": "deepseek", "label": "DeepSeek"},
    {"id": "perplexity", "label": "Perplexity"},
    {"id": "qwen", "label": "Qwen"},
    {"id": "chatgpt", "label": "ChatGPT"},
    {"id": "claude", "label": "Claude"},
    {"id": "zai", "label": "Z.ai"},
    {"id": "kimi", "label": "Kimi"}
  ],
  "tabs": [
    {
      "profileInstanceId": "2671ef2a-a9a1-4687-a7a4-aebbd22afd43",
      "tabId": 42,
      "documentToken": "82d07aa6-44fd-49d7-ab08-c1a95a8d54eb",
      "provider": "chatgpt",
      "title": "ChatGPT",
      "url": "https://chatgpt.com/c/example",
      "ready": true,
      "busy": false,
      "outputKinds": ["text", "image"],
      "input_image_support": true
    }
  ],
  "input_image_support": true,
  "active_request": null,
  "queued_requests": 0
}
```

- Dùng nguyên bộ `profileInstanceId`, `tabId`, `documentToken`, `url` trong `target`. URL trong inventory gồm origin và đường dẫn. Phiên tài liệu lấy từ Chrome và đổi khi tải lại hoặc mở tài liệu mới. URL cũng được kiểm tra ngay trước khi bấm gửi.
- Chỉ cho chọn tab có `ready: true`, `busy: false` và `outputKinds` chứa loại cần dùng. Nếu job có ảnh tham chiếu, kiểm tra `input_image_support` của chính tab. Thuộc tính cấp cao nhất cho biết có ít nhất một tab sẵn sàng hỗ trợ ảnh tham chiếu.
- Khi tải lại, chuyển trang hoặc tab mất kết nối, hãy đọc lại status. Tab mới có thể xuất hiện khi vẫn đang tải với `ready: false`. Một yêu cầu đã ghim sẽ giữ nguyên tab dù người dùng đổi tab đang hiển thị.
- Adapter ảnh chỉ công bố `image` khi nhận diện bộ soạn thảo và chế độ tạo ảnh ChatGPT. Khả năng đính kèm ảnh được công bố khi phát hiện bộ chọn tệp phù hợp, rồi kiểm tra lại ảnh thực sự có trong bộ soạn thảo trước khi gửi. Adapter video công bố `video` khi Grok Imagine có điều khiển tạo video được nhận diện. Dùng khả năng trong phản hồi thực tế để quyết định. Những website còn lại dùng luồng văn bản.

`GET /v1/models`

```json
{
  "object": "list",
  "data": [
    {"id": "bridge-chatgpt", "object": "model", "created": 0, "owned_by": "ai-bridge"}
  ]
}
```

Ví dụ trên trích một mục. Các ID `bridge-auto` và chín model từ phiên bản cũ được giữ nguyên. Danh sách model cho biết các nhà cung cấp được hỗ trợ; dùng `outputKinds` trong status để chọn loại tệp.

## 2. Tải ảnh tham chiếu

`POST /v1/input-images`

```sh
curl -X POST http://127.0.0.1:4319/v1/input-images \
  -H "Authorization: Bearer $BRIDGE_API_KEY" \
  -H "Content-Type: image/png" \
  --data-binary @reference.png
```

Body là bytes gốc. Chấp nhận `image/png`, `image/jpeg` và `image/webp`, tối đa 5 MiB mỗi ảnh. AI-Br đối chiếu chữ ký và kiểm thử giải mã trước khi trả HTTP 201.

```json
{
  "id": "780fa6e8-0db3-4d25-8c21-6296f4c2f51c",
  "mime_type": "image/png",
  "size": 12345,
  "sha256": "49bc6d3e13ba7133d5c08fde06c28d342646bc5408fb628c0ed60892cfa778bb"
}
```

Mỗi tác vụ nhận tối đa 4 ID theo đúng thứ tự với tổng không quá 16 MiB. Tiện ích kiểm tra bytes, gắn ảnh vào đúng phiên tài liệu, chờ trang xác nhận từng ảnh trong bộ soạn thảo, rồi mới xin phép server bấm gửi. Nếu chưa xác nhận được ảnh, tác vụ dừng trước bước gửi.

## 3. Gọi đồng bộ

`POST /v1/chat/completions` với `Content-Type: application/json`

```json
{
  "model": "bridge-chatgpt",
  "stream": false,
  "media_kind": "image",
  "target": {
    "profileInstanceId": "2671ef2a-a9a1-4687-a7a4-aebbd22afd43",
    "tabId": 42,
    "documentToken": "82d07aa6-44fd-49d7-ab08-c1a95a8d54eb",
    "url": "https://chatgpt.com/c/example"
  },
  "messages": [
    {"role": "user", "content": "Tạo một bức ảnh phong cảnh từ ảnh tham chiếu."}
  ],
  "input_images": ["780fa6e8-0db3-4d25-8c21-6296f4c2f51c"]
}
```

- `image` và `video` yêu cầu ít nhất một tệp đúng loại.
- `auto` dùng khả năng của adapter đã chọn và có thể trả văn bản với `media: []` nếu tab hỗ trợ văn bản.
- `none` lấy văn bản. `input_images` có thể là `[]` hoặc bỏ qua.
- Yêu cầu ghim tab dùng `stream: false` (mặc định). Chat văn bản cũ vẫn dùng endpoint này với streaming và phản hồi cũ khi bỏ cả `target`, `media_kind` và `input_images`.
- Đồng bộ giữ kết nối tới khi có kết quả hoặc lỗi. Luồng video dài và cách khôi phục của MacFlow dùng endpoint bất đồng bộ ở mục 5.

Ví dụ HTTP 200

```json
{
  "id": "chatcmpl-52279c3d-0e80-4e91-bb47-218793ffc005",
  "object": "chat.completion",
  "created": 1763395200,
  "model": "bridge-chatgpt",
  "choices": [
    {"index": 0, "message": {"role": "assistant", "content": ""}, "finish_reason": "stop"}
  ],
  "media": [
    {
      "id": "77e67229-5bfe-4159-80cf-05ecd2d103bb",
      "kind": "image",
      "mime_type": "image/png",
      "size": 123456,
      "sha256": "49bc6d3e13ba7133d5c08fde06c28d342646bc5408fb628c0ed60892cfa778bb"
    }
  ]
}
```

Nội dung thuần văn bản có thể rỗng khi trang chỉ phát sinh tệp. `media` chứa tối đa 4 tệp, mỗi tệp tối đa **16 MiB**. Ảnh chấp nhận PNG, JPEG và WebP. Video chấp nhận MP4 và WebM có khung hình giải mã được. Kiểm tra thêm giới hạn 16.777.216 pixel mỗi khung. Một tệp không xác minh được sẽ làm hỏng kết quả media của cả tác vụ. Các tệp có SHA-256 trùng kết quả trước của cùng tab sẽ bị từ chối để tránh đưa tệp cũ vào node.

## 4. Tải tệp vào node

`GET /v1/media/{id}`

```sh
curl --fail -H "Authorization: Bearer $BRIDGE_API_KEY" \
  http://127.0.0.1:4319/v1/media/77e67229-5bfe-4159-80cf-05ecd2d103bb \
  --output result.png
```

HTTP 200 trả bytes nhị phân với `Content-Type` theo MIME đã xác minh, `Content-Length` theo kích thước và `Cache-Control: private, no-store`. MacFlow đối chiếu các header, chữ ký tệp và SHA-256 với metadata trước khi gắn vào node. Tệp được lưu cục bộ và trả trực tiếp từ AI-Br.

## 5. Tác vụ dài và khôi phục

`POST /v1/media/tasks` với `Content-Type: application/json`. Dùng một `client_request_id` dài 1–128 ký tự thuộc nhóm chữ ASCII, số, gạch dưới, chấm, hai chấm hoặc gạch ngang. Lưu ID cùng payload trước khi gửi HTTP.

```json
{
  "client_request_id": "run-348-node-7-attempt-1",
  "model": "bridge-chatgpt",
  "stream": false,
  "media_kind": "image",
  "target": {
    "profileInstanceId": "2671ef2a-a9a1-4687-a7a4-aebbd22afd43",
    "tabId": 42,
    "documentToken": "82d07aa6-44fd-49d7-ab08-c1a95a8d54eb",
    "url": "https://chatgpt.com/c/example"
  },
  "messages": [{"role": "user", "content": "Tạo một bức ảnh phong cảnh."}],
  "input_images": []
}
```

Ví dụ HTTP 202 cho lần tiếp nhận đầu tiên

```json
{
  "task_id": "b193e720-8579-4937-83d3-58993eb3962e",
  "client_request_id": "run-348-node-7-attempt-1",
  "status": "queued",
  "model": "bridge-chatgpt",
  "media_kind": "image",
  "target": {
    "profileInstanceId": "2671ef2a-a9a1-4687-a7a4-aebbd22afd43",
    "tabId": 42,
    "documentToken": "82d07aa6-44fd-49d7-ab08-c1a95a8d54eb",
    "url": "https://chatgpt.com/c/example"
  },
  "created_at": "2026-11-18T04:20:00.000Z",
  "updated_at": "2026-11-18T04:20:00.000Z"
}
```

`GET /v1/media/tasks/{task_id}` trả HTTP 200 cho tác vụ đã biết, với cùng các trường trên và trạng thái hiện tại.

```json
{
  "task_id": "b193e720-8579-4937-83d3-58993eb3962e",
  "client_request_id": "run-348-node-7-attempt-1",
  "status": "completed",
  "model": "bridge-chatgpt",
  "media_kind": "image",
  "target": {
    "profileInstanceId": "2671ef2a-a9a1-4687-a7a4-aebbd22afd43",
    "tabId": 42,
    "documentToken": "82d07aa6-44fd-49d7-ab08-c1a95a8d54eb",
    "url": "https://chatgpt.com/c/example"
  },
  "created_at": "2026-11-18T04:20:00.000Z",
  "updated_at": "2026-11-18T04:20:42.000Z",
  "media": [
    {
      "id": "77e67229-5bfe-4159-80cf-05ecd2d103bb",
      "kind": "image",
      "mime_type": "image/png",
      "size": 123456,
      "sha256": "49bc6d3e13ba7133d5c08fde06c28d342646bc5408fb628c0ed60892cfa778bb"
    }
  ],
  "content": ""
}
```

| Trạng thái | Ý nghĩa |
| --- | --- |
| `queued` | Đã lưu, đang đợi tới lượt. |
| `running` | Đã chuyển sang tiện ích để kiểm tra và thực thi trên tab được chỉ định. |
| `completed` | Có thêm `media` theo mục 3 và trường `content` chứa văn bản trả lời. |
| `failed` | Có thêm `error` với mã và mô tả nguyên nhân đã xác định. |
| `cancelled` | Đã hủy trước khi chuyển yêu cầu tới tiện ích. |
| `unknown` | Website có thể đã nhận prompt. AI-Br giữ mã tác vụ để tra cứu và chặn tạo tác vụ mới trên cùng phiên tài liệu đó. |

`DELETE /v1/media/tasks/{task_id}` hủy tác vụ còn `queued` và trả trạng thái `cancelled`. Tác vụ đã rời hàng đợi trả HTTP 409. Nếu tra cứu UUID chưa từng được ghi nhận, API trả HTTP 404 với `status: "unknown"` và mã `TASK_NOT_FOUND`.

Sau khi có `task_id`, dùng GET để theo dõi. Nếu mất phản hồi HTTP trước khi nhận được ID, gửi lại đúng payload với cùng `client_request_id`. AI-Br trả HTTP 200 kèm tác vụ đã lưu và giữ nguyên lượt chạy. Cùng ID nhưng payload khác trả HTTP 409. Khi tiến trình AI-Br khởi động lại, tác vụ chờ đổi thành `cancelled`, tác vụ đang chạy đổi thành `unknown`, còn tác vụ đã hoàn tất vẫn cung cấp tệp. Thời gian chờ phía bridge tối đa 35 phút từ lúc chuyển tác vụ; nếu chưa rõ kết quả, trạng thái là `unknown`. Hãy xem lại tab trước khi quyết định chạy một tác vụ mới.

## 6. Lỗi

Ví dụ HTTP 409

```json
{
  "error": {
    "code": "TAB_STALE",
    "message": "The tab document has changed. Select it again.",
    "type": "TAB_STALE",
    "param": null
  }
}
```

| HTTP | Mã thường gặp | Xử lý phía MacFlow |
| --- | --- | --- |
| 401 | `INVALID_API_KEY` | Kiểm tra Bearer key. |
| 409 | `TAB_STALE`, `TAB_PROVIDER_MISMATCH`, `TAB_UNSUPPORTED` | Làm mới danh sách rồi chọn đúng tab, model và loại đầu ra. |
| 409 | `TAB_BUSY` | Kiểm tra tình trạng tác vụ đang dùng tab. Phiên chưa rõ kết quả vẫn được giữ bận. |
| 409 | `REQUEST_ID_CONFLICT`, `TASK_NOT_CANCELLABLE` | Tra cứu tác vụ đã lưu. |
| 422 | `INPUT_IMAGE_INVALID`, `INVALID_REQUEST` | Kiểm tra định dạng, kích thước, trường bắt buộc và ảnh đính kèm. |
| 429 | `QUEUE_FULL` | Chờ hàng đợi có chỗ. Tối đa 10 tác vụ chờ toàn dịch vụ. |
| 503 | `EXTENSION_OFFLINE`, `MEDIA_VALIDATOR_UNAVAILABLE` | Kiểm tra kết nối đúng profile hoặc FFmpeg. |
| 503/504 | `TASK_UNKNOWN` | Tra cứu task cũ và kiểm tra trạng thái trên website. |
| 502 | `MEDIA_INVALID` | Tác vụ chưa cung cấp tệp cuối đúng loại, hoặc bytes không qua xác minh. |

## 7. Kiểm thử

Cần Node.js 22.4 trở lên và FFmpeg để chạy `npm test`. Bài thử đưa extension giả qua WebSocket thật, tạo tệp mẫu bằng FFmpeg và kiểm tra cả luồng văn bản hiện có. `npm run test:browser` dùng thêm Chromium (`CHROME_BIN`, mặc định `chromium`) để chạy code content script trên DOM giả lập, code background với Chrome API mô phỏng và server thật. Trang và tệp thử được phục vụ trong phiên trình duyệt cô lập. Môi trường CI yêu cầu chạy Chromium không sandbox có thể đặt `CHROME_NO_SANDBOX=1` cho riêng bài thử này.

Các bài thử mô phỏng kiểm chứng hợp đồng API, định tuyến theo đúng profile/tab, ảnh tham chiếu có xác nhận trước khi gửi, năm định dạng tệp, nhận biết phiên đã tải lại, xác thực, idempotency và phục hồi sau mất kết nối. Cần một lượt kiểm thử riêng có sự đồng ý của người dùng để kiểm chứng giao diện và hạn mức ChatGPT/Grok trên tài khoản thật.
