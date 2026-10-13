T06システム設計書（AR）
1. システム概要
1.1 システム名
Irisona AR & Panorama (仮)
1.2 概要
主サービス（Irisona）で見つけた場所について、利用者がスマートフォンで撮影・投稿したパノラマ風景を季節ごとに閲覧し、周囲を見渡しながら訪問前のイメージを広げるサービス。AR でカメラ映像にその風景を重ね、その場所にいるような体験もできる。


1.3 主な機能
パノラマ撮影機能
パノラマ生成機能
奥行き推定機能
パノラマ投稿機能
立体的な360度ビュー機能
AR表示機能
表示モードの切り替え機能
近くのパノラマのまとめ表示機能
季節・月の切り替え機能
向きの自動補正機能
人物検出・ぼかし機能
パノラマの時間帯での分類機能
1.4 利用者
利用者
説明
一般ユーザー
閲覧はログインなしで利用できる。撮影・投稿はログインが必要
管理者
主サービスの管理者の役割が決まってから定める


2. システム構成
2.1 システム構成図
システムを構成する主要な要素と、その接続関係を示す。主サービスとの関係（同じアプリ内か別アプリか）が未定のため、主サービスと同じ基盤を使う場合の仮の構成とする。
ユーザー（スマートフォン / PCは閲覧のみ）
                │
                ▼
フロントエンド
React / TypeScript / Cloudflare Pages
・カメラ映像の取得
・方位 / 傾きの取得
・撮影案内 / 自動撮影
・パノラマ生成（傾き補正 / 境目のぼかし / 明るさ補正）
・奥行き推定（投稿時に1回）
・人物検出（主サービスの機能を利用）
・人物へのぼかし対応
・立体的な360度ビュー / AR表示の切り替え
・季節・月の切り替え
・地図表示
    │
    ├── 地図取得 ──────────────▶ MapTiler Cloud
    │
    ├── 署名付き画像アップロード ──▶ Cloudinary
    │                              ・パノラマ画像 / 奥行きマップの保存
    │                              ・高解像度 / 低解像度の配信
    │◀────────── 画像URL ──────────┘
    │
    │ API通信（投稿時は画像URLと撮影情報を送信）
    ▼
バックエンド
Hono / Cloudflare Workers
・ユーザー / セッション管理（主サービスと共通の想定）
・パノラマの登録 / 取得
・季節ごと・月ごとの取得
・まとめ表示の候補の取得（距離 / 建造物のタグ）
・画像アップロード署名の発行
・向きの自動補正（方式・実行場所は未定）
    │
    └── データ読み書き ─────────▶ Cloudflare D1
             　　　　　　　　　・投稿情報（shots：画像URL / 位置 / 種別）
             　　　　　　　　　・パノラマ情報
            　　　　　　　　　　（panoramas：撮影日時 / 方位 / 撮影範囲 / 
　　　　　　　　　　　　　　　　　　　　　　　　 向きの補正値 / 奥行きマップURL）
                            ・撮影記録（分析用にcapture_logsにデータ送信）
※WebGPU がない端末では WASM で処理し、処理できない場合は平面表示にする 

2.2 使用技術

分類
技術
フロントエンド
React / TypeScript / Vite / Tailwind CSS（主サービスと共通の想定）
バックエンド
Hono / Cloudflare Workers
データベース
Cloudflare D1（SQLite）
認証
主サービスの認証（SimpleWebAuthn / 独自セッショントークン）を共用する想定
インフラ
Cloudflare Pages / Cloudflare Workers
画像保存
Cloudinary（パノラマ画像と奥行きマップ。AR利用時は高解像度、それ以外は低解像度で配信。奥行きマップに解像度や縦横サイズ、座標系などを合わせる）
地図表示
MapTiler SDK / MapTiler Cloud
立体的な360度ビュー
three.js（奥行きマップでパノラマの面を変形して表示）。Photo Sphere Viewer を使うかは要検討
AR表示
カメラ映像の上に、方位を合わせて別の景色を重ねる（センサーのみによる簡易AR）
奥行き推定
Depth Anything V2 Small などを transformers.js で端末上で実行（WebGPU / WASM）。iOS Safari の対応状況は要確認
カメラ映像の取得
MediaDevices.getUserMedia
方位・傾きの取得
DeviceOrientation API（iOS：webkitCompassHeading、Android：deviceorientationabsolute）
位置情報
Geolocation API
パノラマ生成
端末上で処理。実装手段（Canvas / Web Worker / OffscreenCanvas など）は保留
人物検出
主サービスの人物検出機能（MediaPipe Tasks Vision ObjectDetector / EfficientDet Lite0）を利用する。従サービスでは新たに実装しない

対応端末は iOS Safari 16以上、Android Chrome とし、PCは閲覧のみとする。

3. ユースケース
3.1 ユースケース図
システムで「誰が何を行うか」を図示する。閲覧画面の仕様が未決のため、閲覧関連は特に変更される可能性がある。管理者のユースケースは主サービスの決定後に追加する。
flowchart LR
    User[一般ユーザー]

    subgraph AR [Irisona AR & Panorama]
        subgraph Shoot[撮影・投稿関連（要ログイン）]
            UC1((パノラマを撮影する))
            UC3((仕上がりを確認して投稿する))
        end
        subgraph View[閲覧関連]
            UC4((立体的な360度ビューで見渡す))
            UC9((ARで別の景色を重ねる))
            UC5((季節・時間を切り替える))
            UC6((月でパノラマを探す))
            UC7((同じ季節のほかの投稿を選ぶ))
            UC8((近くのパノラマをまとめて表示する))
        end
    end

    User --- UC1
    User --- UC3
    User --- UC4
    User --- UC5
    User --- UC6
    User --- UC7
    User --- UC8
    User --- UC9


4. データベース設計
4.1 DB方針
保存・取得するデータ項目が未確定のため、本章はすべて仮案とする。データ項目の確定後に更新する。また、主サービスと同じデータベースを使うことを前提とする。
パノラマも主サービスの投稿（shots）の1件として登録する。画像URL・位置情報など写真と共通のデータは shots に入れ、撮影範囲や方位などパノラマになった場合のデータは panoramas に入れる。panoramas は shots と1対1で対応する。
地図上のピンの表示は、主サービスの処理（縮尺に応じたまとめ）にそのまま従う。季節と時間帯は撮影日時から求め、保存しない（仮）。
パノラマは投稿ごとに別のIDを持ち、地点のIDは持たない。GPSには誤差があり、保存時に地点を確定させると誤りを直しにくいため、まとめる処理は保存時ではなく閲覧時に行う。まとめ方は次の2つを区別する。


地図のピン
まとめ表示
目的
地図上の重なりを減らす
近くの風景を季節・月で比べる
決め方
主サービスと同じ（縮尺で変わる）
閲覧時に候補を提案し、閲覧者が選ぶ
保存
しない
しない（閲覧中のみ有効）

まとめ表示の候補は、次の方法で探す。
開いているパノラマから半径○m以内にあるパノラマ（距離は未定。閲覧者が確認するため、主サービスのピンをまとめる距離より広めでもよい）
主サービスの建造物のタグ（shots.tags）が同じパノラマ
候補にはサムネイル・距離・撮影した季節（月）を示し、同じ場所かどうかを閲覧者が判断できるようにする。まとめたパノラマどうしの向きをそろえる必要があるかは要検討とする。

4.1 ER図
主要なテーブルとその関連を示す。users と shots は主サービスのテーブルであり、本書ではパノラマに関わる列のみを示す。
erDiagram
    users {
        TEXT id PK "ユーザーID（主サービス）"
    }

    shots {
        TEXT id PK "投稿ID（主サービス）"
        TEXT user_id FK "投稿者"
        TEXT image_url "画像URL"
        REAL latitude "緯度"
        REAL longitude "経度"
        DATETIME created_at "投稿日時"
        TEXT kind "種別（追加）"
    }

    panoramas {
        TEXT shot_id PK, FK "対応する投稿ID"
        DATETIME captured_at "撮影日時（端末時刻）"
        REAL heading_start "左端の方位"
        REAL coverage_deg "撮影範囲（度）"
        REAL heading_correction "向きの補正値"
        TEXT depth_map_url "奥行きマップURL"
    }

    capture_logs {
        TEXT id PK "記録ID"
        TEXT shot_id FK "対象パノラマ"
        TEXT device_info "端末情報"
        INTEGER shot_count "撮影枚数"
        INTEGER duration_ms "所要時間"
        INTEGER retry_count "撮り直し回数"
        DATETIME created_at "記録日時"
    }

    users ||--o{ shots : "投稿する"
    shots ||--o| panoramas : "パノラマ情報を持つ"
    panoramas ||--o| capture_logs : "撮影記録を持つ"


4.2 テーブル一覧

テーブル名
用途
users
ユーザー情報・認証方式・セッションを管理（主サービス。変更なし）
webauthn_credentials
パスキーの公開鍵などの認証情報を管理（主サービス。変更なし）
shots
投稿の画像URL・位置情報などを管理（主サービス。種別の列を追加）
panoramas
パノラマになった場合の撮影日時・方位・撮影範囲・向きの補正値・奥行きマップのURLを管理
capture_logs
撮影時の端末情報・所要時間など、試作の分析と評価に使う記録を管理

4.3 テーブル定義
shots（主サービスへの追加分）
既存の列は主サービスの設計書を参照。以下の列を追加する。
カラム
型
NULL
キー
説明
kind
TEXT
不可
CHECK(photo / panorama)
投稿の種別。'photo'（写真）または 'panorama'（パノラマ）。既定値：'photo'


panoramas
カラム
型
NULL
キー
説明
shot_id
TEXT
不可
PK、FK → shots.id
対応する投稿ID。shots.kind が 'panorama' の投稿にのみ対応する
captured_at
DATETIME
不可
—
撮影日時。端末の時刻。季節・時間帯はここから求める。JSTで保存する
heading_start
REAL
不可
—
パノラマ左端の方位（北＝0°、時計回り）
coverage_deg
REAL
不可
CHECK(180 ~ 360)
撮影できた範囲（180〜360）。360なら「完全版」。水平方向のみを扱う。
heading_correction
REAL
可
—
向きの自動補正値（度）。補正方式とあわせて未定。パノラマ/ARの投稿の切り替え時に使用
depth_map_url
TEXT
可
—
奥行きマップの画像URL。推定できなかった場合は空とし、立体表示せず平面で表示する。(画像を圧縮してから保存しているためURLで保存している)



capture_logs

カラム
型
NULL
キー
説明
id
TEXT
不可
PK
記録ID
shot_id
TEXT
不可
UNIQUE, FK → panoramas.shot_id
対象のパノラマの投稿ID
device_info
TEXT
可
—
端末の機種・OS
shot_count
INTEGER
不可
—
撮影した枚数
duration_ms
INTEGER
不可
—
撮影開始から完了までの所要時間（ミリ秒）
retry_count
INTEGER
不可
—
撮り直し回数。既定値：0
created_at
DATETIME
可
—
記録日時。既定値：CURRENT_TIMESTAMP




5. API仕様
5.1 API一覧
ID
Method
Endpoint
概要
認証
API-01
POST
/api/login
ログイン
不要
API-02
GET
/api/posts
投稿一覧取得
必要
API-03
GET
/api/posts/{id}
投稿詳細取得
必要
API-04
POST
/api/posts
投稿登録
必要
API-05
PUT
/api/posts/{id}
投稿更新
必要
API-06
DELETE
/api/posts/{id}
投稿削除
必要


5.2 API詳細
API-04 投稿登録
Endpoint
POST /api/posts
概要
新しい投稿を登録する。
認証
必要
Request
{
  "title": "タイトル",
  "content": "本文"
}
Request Parameters
項目
型
必須
説明
title
string
○
投稿タイトル
content
string
○
投稿本文

Response
成功時
HTTP Status
201 Created

{
  "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "title": "タイトル",
  "content": "本文",
  "createdAt": "2026-01-01T12:00:00Z"
}
入力エラー
400 Bad Request

{
  "error": "INVALID_REQUEST",
  "message": "入力内容を確認してください"
}
未認証
401 Unauthorized
権限不足
403 Forbidden
データなし
404 Not Found
サーバーエラー
500 Internal Server Error

6. 画面設計
6.1 画面一覧
ID
画面名
主な利用者
概要
SCR-01
ログイン画面
全ユーザー
ログイン
SCR-02
ホーム画面
一般ユーザー
メイン画面
SCR-03
登録画面
一般ユーザー
データ登録
SCR-04
詳細画面
一般ユーザー
データ詳細表示
SCR-05
管理画面
管理者
システム管理

6.2 画面遷移
flowchart LR

Login[ログイン]
Home[ホーム]
Create[登録]
Detail[詳細]
Edit[編集]

Login --> Home
Home --> Create
Home --> Detail
Detail --> Edit
Edit --> Detail
Create --> Home

7. 認証・権限設計
機能
未ログイン
一般ユーザー
管理者
ログイン
○
-
-
データ閲覧
×
○
○
データ登録
×
○
○
自分のデータ編集
×
○
○
他ユーザーのデータ編集
×
×
○
ユーザー管理
×
×
○


8. 入力チェック
項目
チェック内容
メールアドレス
メールアドレス形式であること
パスワード
8文字以上
タイトル
1〜200文字
本文
必須
数値
指定された範囲内であること


9. エラー処理
システムで発生する主なエラーと処理方法を定義する。
エラー
システムの処理
入力エラー
入力箇所付近にメッセージを表示
認証エラー
ログイン画面へ誘導
権限エラー
操作不可メッセージを表示
API通信エラー
再試行またはエラー表示
DBエラー
一般的なエラーメッセージを表示

内部的なエラー情報やスタックトレースは利用者へ直接表示しない。

10. 非機能要件
10.1 セキュリティ
通信はHTTPSを使用する。
パスワードを平文で保存しない。
API側でも認証・認可を確認する。
SQLインジェクション等への対策を行う。
ユーザー入力を信用せずサーバー側でも検証する。
10.2 性能
通常操作は○秒以内の応答を目標とする。
一覧取得では大量データを一度に取得せず、ページング等を利用する。
10.3 可用性
システム障害時にデータが破損しない設計とする。
必要に応じてバックアップを取得する。
10.4 対応環境
項目
対応範囲
PC
Chrome / Edge
スマートフォン
Chrome / Safari
Android
Android ○以上
iOS
iOS ○以上


11. 外部サービス・外部API
サービス
用途
送信する情報
Google Maps API
地図表示
位置情報
○○ API
○○情報取得
○○
Supabase
DB・認証
ユーザー情報等

外部サービスが停止した場合のシステム動作についても必要に応じて記載する。

12. その他の設計上の注意事項
実装者が判断に迷いそうな事項を記載する。
例：
データ削除は物理削除ではなく論理削除とする。
日時はDB上ではUTCで保存する。
投稿は投稿者本人または管理者のみ編集可能とする。
同一メールアドレスによる複数アカウント登録は禁止する。
外部APIが利用できない場合でも既存データの閲覧は可能とする。

13. 未決事項
設計段階でまだ決定していない事項を管理する。
ID
項目
内容
状態
TODO-01
○○機能
○○の仕様を決定する
未決
TODO-02
API制限
外部APIの利用上限を確認する
確認中


14. 変更履歴
日付
版
内容
担当
YYYY/MM/DD
0.1
初版作成
○○
YYYY/MM/DD
0.2
API仕様追加
○○


15. 制約事項
パノラマ/ARの投稿は一日一件。JST午前0時にリセットする。写真投稿とは別でカウントを行う
DBへの登録は一日一件の制約を守るためトランザクションを含め検討する

