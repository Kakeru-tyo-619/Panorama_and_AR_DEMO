# AR を強化できる技術の一覧（工程別）

作成日：2026-10-13
前提：Web ブラウザ＋サーバーで完結（iOS アプリなし）。撮影方法は今のまま（その場で一周・12枚自動撮影）。
関連資料：[性能の安定化と AR の見せ方：調査まとめ](performance_and_ar_research.md)

## この資料の読み方

AR の表示を、データを作るところから画面に出すところまで **12 の工程** に分け、工程ごとに強化できる技術を集めました。

| 列 | 意味 |
| --- | --- |
| どこで | 端末＝スマホのブラウザ、サーバー＝バックエンド、撮影時＝撮影画面での追加 |
| iPhone | ○ 使える／△ 条件つき・未検証／× 使えない |
| 手間 | 小＝数時間〜1日、中＝数日、大＝1週間以上（目安） |
| 根拠 | 出典がある場合はリンク。「一般的な手法」は広く知られた方法で、今回は出典を確認していないもの |

工程の全体像：

```
[撮影時] A.情報を集める → [サーバー] B.前処理
[端末]   C.カメラ入力 → D.向きの推定 → E.絶対方位への補正 → F.位置の追跡
       → G.何を重ねるか（切り抜き） → H.色・光の合わせ込み → I.3D 表現（視差）
       → J.描画性能 → K.演出 → L.案内・計測
```

---

## A. 撮影時に集める情報（AR のための下ごしらえ）

撮影方法は変えずに、**記録する情報を増やす**だけで、後の工程の精度が上がるものです。

| # | 技術 | 何が良くなるか | どこで | iPhone | 手間 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | **コンパスの精度（`webkitCompassAccuracy`）を写真ごとに記録** | 方位が怪しい写真を後で見分け、合成や補正で重みを下げられる。AR 側でも「今の方位はどれだけ信用できるか」を出せる | 撮影時 | ○ | 小 | [W3C ML](https://lists.w3.org/Archives/Public/public-geolocation/2011Jul/0014.html)、[ArcGIS](https://developers.arcgis.com/javascript/jssamples/mobile_compass.html) |
| A2 | **撮影地点の磁気偏角を記録し、方位を真北基準にそろえる** | iPhone の方位は磁北基準で、日本では真北から西に約 6〜10° ずれる（地域差あり）。地図・3D 都市モデル・太陽の位置と組み合わせるときに必須 | サーバー | ○ | 小 | [国土地理院 磁気図 2020.0年値](https://www.gsi.go.jp/buturisokuchi/menu03_magnetic_chart.html)（2次メッシュごとの偏角データあり） |
| A3 | **撮影時刻・位置から太陽の方位と高さを計算して記録** | 写真に太陽が写っていれば、方位の答え合わせに使える（E4）。時間帯の演出にも使う（K） | サーバー | ○ | 小 | 一般的な手法（SunCalc などの計算ライブラリ） |
| A4 | **ジャイロの回転速度（`devicemotion`）を写真ごとに記録** | ぶれの量が分かり、ぶれた写真を合成から外せる。D の融合フィルタの調整にも使う | 撮影時 | ○ | 小 | [MDN rotationRate](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/rotationRate) |
| A5 | **カメラの実際の画角（hFOV）を推定する** | 今は 65° と仮定している。正しい画角は合成の継ぎ目と AR の大きさの両方に効く。隣り合う写真の重なりの照合結果から逆算できる | サーバー | ○ | 中 | 一般的な手法（OpenCV のバンドル調整で焦点距離を推定） |

## B. サーバーでの前処理（重ねる素材の質を上げる）

| # | 技術 | 何が良くなるか | どこで | iPhone | 手間 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | **特徴点による合成（OpenCV stitching）**：特徴点で位置を合わせ、写真ごとの明るさを補正（gain_blocks）し、継ぎ目を最適化（gc_color）して、多周波数で混ぜる（multiband） | 継ぎ目のずれ・明るさの段差が大きく減る。今はセンサーの方位だけで並べているので、ここの伸びしろが大きい | サーバー | ― | 中 | [OpenCV stitching_detailed](https://docs.opencv.org/4.11.0/d9/dd8/samples_2cpp_2stitching_detailed_8cpp-example.html) |
| B2 | **パノラマ専用の奥行き推定（DA360・PanDA）** | 今は通常の写真用モデルを8タイルに分けて推定している。パノラマ専用モデルは、0°/360° のつなぎ目や上下のゆがみに強い。DA360 は PanDA より誤差が約3割少ないと報告されている | サーバー | ― | 中 | [DA360（arXiv 2512.22819）](https://arxiv.org/abs/2512.22819v1)、[PanDA（CVPR 2025）](https://openaccess.thecvf.com/content/CVPR2025/html/Cao_PanDA_Towards_Panoramic_Depth_Anything_with_Unlabeled_Panoramas_and_Mobius_CVPR_2025_paper.html)。Web 向けの変換済みモデルは見つからず、サーバーで PyTorch のまま動かす想定 |
| B3 | **大きい奥行きモデルを使う**（Depth Anything V2 / V3 の Large） | サーバーならメモリの制約がなく、輪郭の細かい奥行きが得られる | サーバー | ― | 小 | [Depth Anything V3 ONNX](https://huggingface.co/Jens-Duttke/Depth-Anything-3-MONO-ONNX) |
| B4 | **空の切り抜きマスクを作って保存**（空・水・人の分割モデル SkyWater-Seg） | AR で「パノラマの空だけを重ねる」「空だけ入れ替える」ができる。奥行きのしきい値より、境目がはっきりする | サーバー | ― | 小〜中 | [SkyWater-Seg（MIT、空の IoU 92.1% と作者報告）](https://huggingface.co/Realcat/skywater_seg) |
| B5 | **画素ごとの分類（建物・木・道路・空など）**（SegFormer の ADE20K 学習済みモデル） | 「建物だけ過去の姿を重ねる」「木だけ季節を変える」など、重ねる対象を選べる | サーバー | ― | 中 | [SegFormer](https://cdn.jsdelivr.net/gh/nvlabs/segformer@master/README.md) |
| B6 | **隠れた部分の穴埋め（LaMa）** | 視点を動かすと、手前の物の裏側に穴が見える。それを自然に埋められる。3D 表示の「引き伸ばされた膜」が減る | サーバー | ― | 中 | [LaMa ONNX（入力は 512×512 固定）](https://huggingface.co/Carve/LaMa-ONNX)。学習データの利用条件が研究・教育向けなので、卒業制作なら問題ない見込み |
| B7 | **奥行きの層に分けて穴埋めする「3D 写真」方式**（層状の奥行き画像） | B6 をより正しく行う方法。前景と背景を分けて背景側だけを埋めるので、境目がぼけない | サーバー | ― | 大 | [3D Photography (CVPR 2020)](https://arxiv.org/pdf/2004.04727) |
| B8 | **人物の切り抜きでぼかしを精密にする** | 今は四角い枠でぼかしている。人の形に沿ってぼかせる（B4 のモデルは人も分類できる） | サーバー | ― | 小 | [SkyWater-Seg](https://huggingface.co/Realcat/skywater_seg) |
| B9 | **時間帯の光を変える（IC-Light）** | 昼のパノラマから夕方・夜の雰囲気を作れる。季節の変化（雪・紅葉）には向かない | サーバー | ― | 大 | [IC-Light（Stable Diffusion ベース）](https://comfyui-wiki.com/en/models/ic-light) |
| B10 | **パノラマから 3D の世界を生成（World Labs Marble）** | 1枚のパノラマから、歩き回れる 3D（Gaussian Splatting）を作る。ただし見えない部分は AI の想像なので、記録としての正確さはない | 外部サービス | ― | 中 | [World Labs Marble（書き出しは有料プラン）](https://docs.worldlabs.ai/marble/export/gaussian-splat.md) |

## C. カメラ入力

| # | 技術 | 何が良くなるか | どこで | iPhone | 手間 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | **`requestVideoFrameCallback` で映像のフレームに合わせて描く** | カメラ映像とパノラマの描画のタイミングがそろい、動かしたときの「遅れて付いてくる」感じが減る | 端末 | ○（iOS 15.4〜） | 小 | [caniuse](https://caniuse.com/wf-request-video-frame-callback)、[web.dev](https://web.dev/articles/requestvideoframecallback-rvfc?hl=en) |
| C2 | **カメラ映像も WebGL に取り込み、1枚の画面で合成する** | 今は `<video>` の上に WebGL を重ねている。同じシェーダーで合成すれば、色合わせ（H）や境目の処理がカメラ映像側にもかけられる | 端末 | ○ | 中 | 一般的な手法 |
| C3 | **ライト（torch）の制御** | 夜の撮影・AR で手元を照らせる。zoom・露出・ホワイトバランスの制御は iPhone では使えない見込み | 端末 | △（torch のみ） | 小 | [WebKit Bug 243075](https://bugs.webkit.org/show_bug.cgi?id=243075)、[Dynamsoft](https://www.dynamsoft.com/codepool/camera-zoom-control-on-web.html) |
| C4 | **Worker でカメラのフレームを受け取る（MediaStreamTrackProcessor）** | E・F の画像処理を画面の描画から切り離せる | 端末 | ○（iOS 18〜） | 中 | [WebKit Bug 241124](https://bugs.webkit.org/show_bug.cgi?id=241124) |

## D. 向きの推定（センサー）

| # | 技術 | 何が良くなるか | どこで | iPhone | 手間 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | **ジャイロ・加速度・コンパスの融合（Madgwick / Mahony フィルタ）** | 速い動きは反応の速いジャイロ、ゆっくりしたずれはコンパスで直す。揺れが大きく減る。`ahrs` という npm パッケージあり | 端末 | ○ | 小〜中 | [ahrs (npm)](https://www.npmjs.com/package/ahrs)、[three.js フォーラム：揺れの報告](https://discourse.threejs.org/t/deviceorientation-controls-are-shaky/18548) |
| D2 | **表示時刻までの動きを予測して描く** | 回転速度 × 表示までの遅れの分だけ先回りして描くと、遅れが減る（C1 の予定表示時刻を使う） | 端末 | ○ | 小 | 一般的な手法 |
| D3 | **コンパスの精度に応じて、コンパスの効かせ方を変える** | 精度が悪い（例：±20° 超）ときはコンパスをほぼ使わず、ジャイロだけで追う。急に 30° 飛ぶ問題を防ぐ | 端末 | ○ | 小 | [W3C ML](https://lists.w3.org/Archives/Public/public-geolocation/2011Jul/0014.html) |
| D4 | **画面の回転（横向き）の補正** | 横向きに持っても方位と傾きが正しくなる | 端末 | ○ | 小 | 一般的な手法（`screen.orientation.angle`） |

## E. 絶対方位への補正（コンパスのずれを消す）

ここが **AR の「ずれて見える」を直す本丸** です。コンパスの誤差（±10° 前後）を、画像や地理データで補正します。

| # | 技術 | 何が良くなるか | どこで | iPhone | 手間 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | **カメラ映像とパノラマのスカイライン（空と建物の境目）の照合** | 傾きはセンサーで分かるので、残るのは「左右のずれ」だけ。1次元の照合で済み、軽い。照合の良さが低いときは採用しない仕組みも入れられる | 端末 | ○ | 中 | [スカイライン照合の研究（距離変換による1次元照合）](https://hal-univ-rennes1.archives-ouvertes.fr/hal-01296969) |
| E2 | **地形データ（標高）から計算した稜線との照合** | 山が見える場所なら、撮影時のパノラマも含めて絶対方位が分かる。報告では 86% の画像で誤差 0.2° 未満 | サーバー＋端末 | ○ | 大 | [Nagy 2020（PFG）](https://link.springer.com/article/10.1007/s41064-020-00093-1)、[ISPRS Annals 2014](https://isprs-annals.copernicus.org/articles/II-5/181/2014/)。標高は国土地理院の標高タイルが使える見込み |
| E3 | **国の 3D 都市モデル（PLATEAU）の建物の輪郭との照合** | 街中で使える E2。建物の形から絶対方位を出せる。G2 の手前の建物の遮蔽にも使える | サーバー＋端末 | ○ | 大 | [PLATEAU チュートリアル](https://www.mlit.go.jp/plateau/learning/tpc14-1/)。three.js で読むときは位置ずれ（CESIUM_RTC）の補正が必要 |
| E4 | **太陽の位置で答え合わせ** | 太陽が映っていれば、計算上の太陽の方位と比べて補正できる。写真アプリ（PhotoPills）では、手で太陽に合わせる方式を採用 | 端末 | ○ | 小〜中 | [PhotoPills](https://photopills.com/blog/update-photopills-2-1-1) |
| E5 | **特徴点による照合（SuperPoint ＋ LightGlue）** | E1 より精密。建物の窓や看板など、細かい点で位置を合わせる。重いのでサーバーで処理するか、時々だけ行う | サーバー | ― | 大 | [LightGlue-ONNX](https://github.com/fabio-sim/lightglue-onnx)（ブラウザでの動作は未確認） |
| E6 | **位相相関（FFT）による回転量の推定** | 撮影地点からほぼ動かない前提なので、カメラ映像とパノラマの「左右の回転量」だけを高速に求められる | 端末 | ○ | 中 | 一般的な手法 |
| E7 | **手動合わせの改善**：二本指で左右にずらし、合わせた値をその場所の補正値として保存して共有 | 一度誰かが合わせれば、次の人は最初から合った状態で見られる（`heading_correction` を本番で育てる） | 端末＋サーバー | ○ | 小 | 一般的な手法 |

## F. 位置の追跡（スマホを動かしても景色に貼り付かせる）

| # | 技術 | 何が良くなるか | どこで | iPhone | 手間 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | **8th Wall エンジン（バイナリ版）の位置追跡（SLAM）** | WebXR なしで、iPhone の Safari でも景色に固定する AR ができていたエンジン。無料だが限定利用ライセンス | 端末 | △（今の iOS での動作は未検証） | 中 | [8thwall/engine](https://github.com/8thwall/engine)、[8th Wall ブログ](https://www.8thwall.com/blog/post/208587408737/8th-wall-open-source) |
| F2 | **AlvaAR（オープンソースの SLAM、WebAssembly）** | F1 の代わり。ORB-SLAM2 系。ライセンスは GPLv3（公開するソース全体に影響する）。最終更新は 2023年で、iPhone での動作報告は見つからなかった | 端末 | △ | 大 | [AlvaAR](https://github.com/alanross/AlvaAR) |
| F3 | **Android だけ WebXR（ARCore）を使う** | 位置追跡・平面検出・奥行き・光の推定がブラウザで使える。iPhone との比較を発表で見せられる | 端末 | ×（Android のみ） | 中 | [ARCore と WebXR の比較](https://developers.google.com/ar/develop/webxr/arcore-comparison?hl=en) |
| F4 | **追跡の基準を最初の E の補正で決める** | SLAM は開始時の向きを基準に追うだけなので、北の方向は E で合わせる。F と E はセットで使う | 端末 | ○ | 小 | 一般的な手法 |

## G. 何を重ねるか（切り抜き・前後関係）

| # | 技術 | 何が良くなるか | どこで | iPhone | 手間 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | **カメラ映像の空をその場で切り抜く（8th Wall の Sky Effects、MIT 版に含まれる）** | 今の空だけを、パノラマの空（夕焼け・雪空）に入れ替えられる。演出の効果が大きい | 端末 | △（動作は未検証） | 中 | [8thwall/8thwall（MIT）](https://github.com/8thwall/8thwall)、[エンジンの README](https://github.com/8thwall/8thwall/tree/main/packages/engine) |
| G2 | **3D 都市モデルで手前の建物を隠す** | パノラマの遠景が、実際の手前の建物の後ろに回り込んで見える | 端末 | ○ | 大 | [PLATEAU チュートリアル（オクルージョンへの活用に言及）](https://www.mlit.go.jp/plateau/learning/tpc14-1/) |
| G3 | **人を前に出す（人物の切り抜き）** | 通行人がパノラマの手前に表示され、合成っぽさが減る | 端末 | ○ | 中 | [MediaPipe Image Segmenter](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter/web_js) |
| G4 | **境目をカメラ映像の輪郭に吸着させる（ガイデッドフィルタ）** | 低解像度の奥行きや切り抜きの境目を、カメラ映像の輪郭に合わせてくっきりさせる。GPU で軽く動く | 端末 | ○ | 中 | [Guided Image Filtering](https://people.csail.mit.edu/kaiming/eccv10/index.html)、[Bilateral Guided Upsampling](https://history.siggraph.org/?p=210536) |
| G5 | **切り抜きを時間方向になめらかにする** | フレームごとに境目がチラつくのを防ぐ | 端末 | ○ | 小 | 一般的な手法 |
| G6 | **B5 の分類を使って重ねる対象を選ぶ**（建物だけ・木だけなど） | 「この建物は昔こうだった」のように、意味のある単位で見せられる | 端末 | ○ | 小（B5 があれば） | ― |

## H. 色・光の合わせ込み（合成の自然さ）

| # | 技術 | 何が良くなるか | どこで | iPhone | 手間 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| H1 | **色の統計を合わせる（Reinhard の色転送）** | カメラ映像とパノラマの色の平均とばらつきを合わせる。浮いて見える感じが減る。シェーダーで軽く動く | 端末 | ○ | 小 | [Disney Research](https://la.disneyresearch.com/wp-content/uploads/Fast-and-Stable-Color-Balancing-for-Images-and-Augmented-Reality-Paper.pdf)、[TU Wien（AR 向け）](https://www.cg.tuwien.ac.at/research/publications/2011/knecht-2011-CBCM/knecht-2011-CBCM-Preprint.pdf) |
| H2 | **合わせる度合いを選べるようにする** | 「今の光に合わせる（なじませる）」と「過去の光のまま（差を見せる）」を切り替えられる。体験の意図で選ぶ | 端末 | ○ | 小 | ― |
| H3 | **ぼけ・ノイズ・周辺減光をカメラ映像に合わせる** | パノラマだけくっきりしすぎて浮くのを防ぐ | 端末 | ○ | 小 | 一般的な手法 |
| H4 | **動きのぶれを合わせる** | 速く振ったときにカメラ映像はぶれるので、パノラマにも同じ方向のぶれを付ける | 端末 | ○ | 中 | 一般的な手法 |

## I. 3D 表現（視差）

| # | 技術 | 何が良くなるか | どこで | iPhone | 手間 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| I1 | **Gaussian Splatting の表示（Spark）** | B10 などで作った 3D の世界を、three.js で表示できる。WebGL2 ベースでスマホ向け | 端末 | △（Safari の動作は要確認） | 中 | [Spark](https://github.com/sparkjsdev/spark) |
| I2 | **奥行きの層ごとの表示（B7 の結果を使う）** | 視点を動かしたときに、手前と奥が自然に分かれて見える | 端末 | ○ | 中 | [3D Photography](https://arxiv.org/pdf/2004.04727) |
| I3 | **奥行きの不連続部分でメッシュを切る** | 手前と奥の間に張られる「膜」を消す（穴は B6 で埋める） | 端末 | ○ | 小 | 一般的な手法 |

## J. 描画性能（安定して動かす）

| # | 技術 | 何が良くなるか | どこで | iPhone | 手間 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| J1 | **テクスチャ圧縮（KTX2 / Basis の UASTC → iPhone では ASTC）** | GPU メモリが数分の1になる見込み。4096px のパノラマを持ったままでも落ちにくくなる。圧縮はサーバーで行う | サーバー＋端末 | ○（透明部分ありの画像は要確認） | 中 | [Babylon.js フォーラム（UASTC → ASTC）](https://forum.babylonjs.com/t/opacitytexture-not-working-on-ios-15-devices/25102?page=2)、[three.js フォーラム](https://discourse.threejs.org/t/textures-in-gltf-sometimes-display-black-but-only-on-ios/30520) |
| J2 | **パノラマをタイルに分け、見えている範囲だけ読み込む** | AR は画面に映る約 65° 分しか使わない。4096px 全体を GPU に置かなくて済む | 端末 | ○ | 中 | 一般的な手法 |
| J3 | **描画の細かさを端末に合わせて自動で下げる** | 描画の速さを見て、画面の解像度やメッシュの細かさを調整する | 端末 | ○ | 小 | 一般的な手法 |

## K. 演出（変化をはっきり見せる）

| # | 技術 | 何が良くなるか | どこで | iPhone | 手間 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| K1 | **のぞき窓**：指でなぞった部分・円の中だけ過去が見える | 今と過去の差が、触る体験として分かる | 端末 | ○ | 小 | ― |
| K2 | **時間スライダー**：同じ場所の複数のパノラマ（季節・時間帯）を、つまみで連続的に切り替える | 季節の移り変わりを一続きで見せられる。今ある「近くのパノラマのまとめ表示」の AR 版 | 端末 | ○ | 中 | ― |
| K3 | **空の入れ替え**（G1 または B4） | 今の空が過去の夕焼けや雪空に変わる。一番分かりやすい演出 | 端末 | △ | 中 | ― |
| K4 | **天気・季節のパーティクル**（雪・桜・雨） | 撮影した月から季節が分かるので、その季節の粒を降らせる | 端末 | ○ | 小 | 一般的な手法 |
| K5 | **太陽の位置に合った空の描画**（three.js の空シェーダー＋A3） | 未撮影の上空を、撮影時刻の太陽の位置を持つ空で自然に埋める | 端末 | ○ | 小 | 一般的な手法 |
| K6 | **立体音響**：その季節・時間の環境音を方向つきで鳴らす（Web Audio） | 見るだけでなく、聞いても過去の場所にいる感覚を作れる | 端末 | ○ | 小 | 一般的な手法 |
| K7 | **今と過去を並べた短い動画の書き出し** | AR の画面を録画して共有できる。発表資料にも使える | 端末 | △（画面の録画機能の対応を要確認） | 中 | 一般的な手法 |
| K8 | **重ね始めの演出**（波紋・ディゾルブで過去が浮かび上がる） | 「重なった瞬間」を印象的にする | 端末 | ○ | 小 | ― |

## L. 案内・計測（正しく見てもらう／良くなったかを測る）

| # | 技術 | 何が良くなるか | どこで | iPhone | 手間 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | **撮影地点への誘導（リフォトグラフィー）** | AR は撮影地点から見るのが一番正確。過去の撮影地点まで、矢印で連れて行く | 端末 | ○ | 中 | [Computational Rephotography（2010）](https://people.csail.mit.edu/soonmin/rephoto/rephoto.pdf)、[ReCapture（UIST 2022）](https://www.cs.cornell.edu/abe/projects/recapture) |
| L2 | **合っている度合いの表示** | E1 の照合の良さやコンパスの精度を、色付きの表示で出す。ずれているときに「少し左右に動かしてください」と案内できる | 端末 | ○ | 小 | ― |
| L3 | **コンパスの調整の案内**（8の字に振る） | 精度が悪いときに案内を出すと、ずれが減る | 端末 | ○ | 小 | [PhotoPills（端末を振ってセンサーを落ち着かせる案内）](https://photopills.com/blog/update-photopills-2-1-1) |
| L4 | **ずれの計測をログに残す** | E1 で求めた補正量を記録すれば、「コンパスだけだと平均何度ずれるか」「補正でどれだけ減ったか」を数字で示せる。卒業制作の評価に使える | 端末＋サーバー | ○ | 小 | ― |

---

## 注目度の高い組み合わせ（私の見立て）

| 目的 | 組み合わせ | 理由 |
| --- | --- | --- |
| **ずれ・揺れを直す（土台）** | D1（センサー融合）＋ E1（スカイライン照合）＋ L2（合い具合の表示） | すべて端末だけで、追加の費用なし。AR の「合成っぽさ」の一番の原因に直接効く |
| **パンチを出す** | G1/B4（空の切り抜き）＋ K3（空の入れ替え）＋ K1（のぞき窓）＋ K2（時間スライダー） | 「過去と今の違い」が一目で分かる演出 |
| **合成を自然に見せる** | H1（色合わせ）＋ G4（境目の吸着）＋ H3（ぼけ・ノイズ） | シェーダーだけで済み、軽い |
| **素材の質を上げる（サーバー）** | B1（特徴点による合成）＋ B2（パノラマ専用の奥行き）＋ B4（空のマスク） | サーバー処理に移すなら、同時に質も上げられる |
| **日本ならではの強み** | A2（磁気偏角）＋ E3/G2（PLATEAU）＋ E2（国土地理院の標高） | 国の公開データで、方位補正と遮蔽ができる。発表での独自性にもなる |
| **景色に固定する（挑戦枠）** | F1（8th Wall の SLAM）＋ F4 | iPhone のブラウザで「貼り付く AR」を狙える唯一の候補。まず検証から |

## 未確認・注意点のまとめ

- 8th Wall のエンジン（F1・G1）が今の iOS で動くか、ライセンスが卒業制作の用途に合うかは未確認です。
- iPhone の Safari の WebGPU と MediaStreamTrackProcessor の正式な対応状況は、資料ごとに記述が食い違っています。
- PanDA・DA360 のブラウザ向けの変換済みモデルは見つかりませんでした。サーバーでの利用が前提です。
- 「一般的な手法」と書いた項目は、今回出典を確認していません。実装前に個別に確認します。
