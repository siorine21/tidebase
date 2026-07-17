# 🎣 TIDEBASE — Phase 0 環境構築手順書

> **ver 2.0 | 2026年2月26日**

| 項目 | 内容 |
|------|------|
| 対象フェーズ | Phase 0 — 開発環境セットアップ |
| 所要時間 | 約3〜4時間（初回） |
| 前提条件 | AWSアカウント取得済み / マネコン操作経験あり |
| ゴール | ローカル開発環境 + AWS無料枠構成 + Supabase接続が完了し、Hello World APIが動く状態 |
| コスト目安 | 月$0（AWS永久無料枠 + Supabase無料プラン） |

> ⚠️ 本手順は **macOS / Linux 環境**を想定しています。  
> Windows の場合は WSL2（Ubuntu）を使用してください。  
> コマンドブロック（` ``` `）はターミナルで実行します。

---

## 0. Phase 0 の全体ゴール

Phase 0 が完了した時点で、以下の状態になっていること：

- [ ] ① ローカルで FastAPI サーバーが起動し、SwaggerUI で確認できる
- [ ] ② Supabase に DB が作成済みで、ローカルから SQL 接続できる
- [ ] ③ AWS CLI が設定済みで、S3 バケットの一覧が取得できる
- [ ] ④ SAM コマンドで Lambda をローカル起動できる（Hello World）
- [ ] ⑤ CodeCommit リポジトリが作成済みで初回コミットが入っている

### 作業ステップ一覧

| ステップ | 内容 | 所要時間 | 難易度 |
|----------|------|----------|--------|
| Step 1 | ローカル開発ツールのインストール | 30分 | ★☆☆ |
| Step 2 | AWS IAM ユーザー作成 & CLI 接続 | 30分 | ★★☆ |
| Step 3 | CodeCommit リポジトリ作成 & プロジェクト構成 | 25分 | ★☆☆ |
| Step 4 | Supabase プロジェクト作成 & DB 初期設定 | 30分 | ★★☆ |
| Step 5 | 環境変数管理（.env ファイル）の設定 | 20分 | ★☆☆ |
| Step 6 | SAM（Lambda）ローカル環境構築 | 40分 | ★★☆ |
| Step 7 | FastAPI Hello World の実装と動作確認 | 30分 | ★☆☆ |
| Step 8 | Supabase 自動停止防止 Lambda の設定 | 20分 | ★★☆ |
| Step 9 | 動作確認チェックリスト | 10分 | ★☆☆ |

> **ステップ順の依存関係**  
> Step 2（IAM/CLI）→ Step 3（CodeCommit）の順が必須です。  
> CodeCommit への接続には Step 2 で作成する AWS CLI プロファイルが必要なため、  
> Step 3 より先に Step 2 を完了させてください。

---

## Step 1 — ローカル開発ツールのインストール

### 必須ツール一覧

| ツール | バージョン目安 | 用途 | 確認コマンド |
|--------|---------------|------|-------------|
| Python | 3.11以上 | FastAPI・Lambda 関数の実行環境 | `python3 --version` |
| pip / venv | （Python付属） | パッケージ管理・仮想環境 | `pip3 --version` |
| Node.js | 20 LTS以上 | SAM CLI・フロントツール | `node --version` |
| AWS CLI | v2 | AWS サービスの操作 | `aws --version` |
| AWS SAM CLI | 最新 | Lambda ローカル実行・デプロイ | `sam --version` |
| Docker Desktop | 最新 | SAM のローカル実行に必要 | `docker --version` |
| Git | 2.x | バージョン管理 | `git --version` |
| git-remote-codecommit | 最新 | CodeCommit への Git 認証ブリッジ | `pip show git-remote-codecommit` |
| VS Code（推奨） | 最新 | エディタ | `code --version` |

### 1.1 macOS でのインストール

**Homebrew（未導入の場合）**
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

> ⚠️ **Apple Silicon Mac（M1/M2/M3）** は Homebrew のインストール後に PATH 設定が必要：
> ```bash
> echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zshrc
> source ~/.zshrc
> brew --version   # バージョンが表示されれば成功
> ```

**Python 3.11**
```bash
brew install python@3.11
python3.12 --version
```

> ⚠️ `python3.12` コマンドが見つからない場合は PATH を追加する：
> ```bash
> echo 'export PATH="/opt/homebrew/opt/python@3.11/bin:$PATH"' >> ~/.zshrc
> source ~/.zshrc && python3.12 --version
> ```

**Node.js 20 LTS**
```bash
brew install node@20
node --version
```

> ⚠️ `node` コマンドが見つからない場合（keg-only のため）：
> ```bash
> echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc
> source ~/.zshrc && node --version
> ```

**AWS CLI v2**
```bash
brew install awscli
aws --version
```

**Docker Desktop**

https://www.docker.com/products/docker-desktop/ からインストーラをDL・実行。

インストール後に以下の手順で設定する。

**① 起動確認**  
Docker Desktop を起動し、タスクバーのアイコンが緑（Running）になるまで待つ（1〜2分）。

**② WSL2 インテグレーションの有効化（WSL2/Ubuntu 環境の場合は必須）**

```
Docker Desktop → 右上の歯車アイコン（Settings）
  → Resources
    → WSL Integration
      → 「Enable integration with my default WSL distro」を ON
      → 使用している WSL2 ディストリビューション（Ubuntu 等）のトグルを ON
      → 「Apply & Restart」をクリック
```

**③ WSL2 側で動作確認**

```bash
docker --version
# → Docker version xx.x.x が表示されれば成功

docker ps
# → コンテナ一覧（空でも可）が表示されれば成功
# → エラーが出る場合は Docker Desktop を再起動して再試行
```

> ⚠️ WSL2 インテグレーションが設定されていないと、SAM のローカル実行時に  
> `Do you have Docker or Finch installed and running?` エラーが発生します。

**AWS SAM CLI**
```bash
brew install aws-sam-cli
sam --version
```

**Git の初期設定（.gitconfig）**

```bash
# コミット時の Author 情報（未設定だと git commit がエラーになる）
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"

# デフォルトブランチを master に統一
git config --global init.defaultBranch master

# 確認
git config --global --list
# → user.name / user.email / init.defaultBranch が表示されれば成功
```

**git-remote-codecommit**
```bash
pip3 install git-remote-codecommit
pip show git-remote-codecommit   # バージョンが表示されれば成功
```

### 1.2 WSL2/Ubuntu でのインストール

```bash
# Python 3.11
sudo apt update && sudo apt install -y python3.12 python3.12-venv python3-pip

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# AWS CLI v2
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
unzip awscliv2.zip && sudo ./aws/install

# SAM CLI
pip3 install aws-sam-cli --user

# git-remote-codecommit
pip3 install git-remote-codecommit --user
```

---

## Step 2 — AWS IAM ユーザー作成 & CLI 接続

> 🔐 IAM ユーザーを作成して AWS CLI を設定します。  
> root アカウントで CLI を使うのはセキュリティリスクがあるため、必ず IAM ユーザーを使います。  
> **このステップを完了しないと Step 3（CodeCommit）に進めません。**

### 2.1 IAM ユーザーの作成（マネコン操作）

| 手順 | 操作内容 |
|------|---------|
| 1 | AWS マネコン → IAM → ユーザー → 「ユーザーを作成」 |
| 2 | ユーザー名：`yuki` |
| 3 | 「AWS マネジメントコンソールへのアクセスを提供する」→ チェックしない（CLI 専用） |
| 4 | 「直接ポリシーをアタッチ」→ 以下のポリシーを追加 |
| | ・`AWSCodeCommitFullAccess` ← **CodeCommit 操作に必須** |
| | ・`AmazonS3FullAccess` |
| | ・`AWSLambda_FullAccess` |
| | ・`AmazonAPIGatewayAdministrator` |
| | ・`AWSCloudFormationFullAccess` ← **SAM deploy に必須** |
| | ・`IAMFullAccess` ← **SAM が IAM ロールを作成するため必須** |
| | ・`CloudFrontFullAccess` |
| | ・`AmazonSSMFullAccess` ← **Step 8 の SSM Parameter Store 操作に必須** |
| | ・`AmazonEventBridgeFullAccess` ← **Step 8 の EventBridge ルール作成に必須** |
| 5 | ユーザー作成後「アクセスキーを作成」→「CLI の使用」→ CSV をダウンロード（**このタイミングのみ表示**） |

### 2.2 AWS CLI プロファイル設定

```bash
aws configure --profile yuki
```

```
AWS Access Key ID [None]:     ← CSV のアクセスキー
AWS Secret Access Key [None]: ← CSV のシークレットキー
Default region name [None]:   ap-northeast-1
Default output format [None]: json
```

**接続確認**
```bash
aws sts get-caller-identity --profile yuki
# → "UserId", "Account", "Arn" が表示されれば成功
```

### 2.3 S3 バケットの作成

```bash
aws s3 mb s3://tidebase-media-dev    --region ap-northeast-1 --profile yuki
aws s3 mb s3://tidebase-frontend-dev --region ap-northeast-1 --profile yuki

# 確認
aws s3 ls --profile yuki
```

| バケット名 | 用途 |
|-----------|------|
| `tidebase-media-dev` | 釣果写真・スポット写真のアップロード先 |
| `tidebase-frontend-dev` | フロントエンドの静的ホスティング（Phase 2〜） |

---

## Step 3 — CodeCommit リポジトリ作成 & プロジェクト構成

> 💡 **CodeCommit を選ぶ理由**  
> IAM でそのまま認証できる・VPC 内に閉じられる・CodePipeline と直結できる。  
> 5 アクティブユーザーまで**永続無料**（12 ヶ月制限なし）。個人開発は $0 で使える。  
> **Step 2 の IAM/CLI 設定が完了していることを確認してから進めてください。**

### 3.1 CodeCommit リポジトリ作成（マネコン操作）

| 手順 | 操作内容 |
|------|---------|
| 1 | AWS マネコン → **CodeCommit** → 「リポジトリを作成」 |
| 2 | リポジトリ名：`TideBaseRepo` |
| 3 | 説明：`TIDEBASE — Your Fishing Knowledge Base`（任意） |
| 4 | 「作成」ボタンをクリック |
| 5 | 作成後に表示される **HTTPS URL** をメモしておく |

> ✅ CodeCommit リポジトリは**デフォルトで Private**。公開設定の選択肢はない（完全非公開）。

### 3.2 接続確認

Step 2 で設定した CLI プロファイルで CodeCommit にアクセスできることを確認する。

```bash
git ls-remote codecommit://yuki@TideBaseRepo
# → 何も表示されないか空のリスト → 成功（まだ空のリポジトリ）
# → エラーが出る場合は Step 2 の IAM ポリシーを確認
```

> **`codecommit://` URL の構造**  
> `codecommit://[CLIプロファイル名]@[リポジトリ名]`  
> プロファイル名は Step 2 で設定した `yuki`。

### 3.3 ローカルにクローン

```bash
git clone codecommit://yuki@TideBaseRepo
cd TideBaseRepo
```

### 3.4 プロジェクトディレクトリ構成の作成

```
TideBaseRepo/
├── backend/                   # FastAPI アプリケーション
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py            # FastAPI エントリポイント
│   │   ├── ping.py            # Supabase 自動停止防止 Lambda
│   │   ├── api/               # ルーター（routes）
│   │   ├── models/            # Pydantic モデル
│   │   ├── services/          # ビジネスロジック
│   │   └── db/                # Supabase 接続設定
│   ├── tests/
│   ├── requirements.txt
│   └── requirements-dev.txt
├── infrastructure/            # SAM テンプレート・IaC コード
│   ├── template.yaml          # AWS SAM テンプレート
│   └── samconfig.toml
├── frontend/                  # Jinja2 テンプレート（Phase 2〜）
├── docs/                      # 仕様書・設計ドキュメント
├── .env.example               # 環境変数のサンプル
├── .gitignore
├── Makefile
└── README.md
```

**ディレクトリ一括作成**
```bash
mkdir -p backend/app/{api,models,services,db} backend/tests infrastructure frontend docs
touch backend/app/__init__.py backend/app/main.py backend/app/ping.py
touch backend/app/db/__init__.py          # db をパッケージとして認識させるために必須
touch backend/app/api/__init__.py         # 同上
touch backend/requirements.txt backend/requirements-dev.txt
touch infrastructure/template.yaml .env.example Makefile
```

### 3.5 .gitignore の作成

```bash
cat > .gitignore << 'EOF'
# 環境変数・秘密情報
.env
env.json

# Python
backend/.venv/
__pycache__/
*.pyc
*.pyo
*.pyd
.Python

# AWS SAM
.aws-sam/
samconfig.toml

# IDE
.vscode/
.idea/
EOF
```

### 3.6 初回コミット & プッシュ

```bash
git add .
git commit -m "chore: initial project structure"
git push
```

**確認**
```bash
git log --oneline
# → "chore: initial project structure" が表示されれば成功

# マネコンでも確認：CodeCommit → TideBaseRepo → ファイル一覧が表示されること
```

---

## Step 4 — Supabase プロジェクト作成 & DB 初期設定

> 🗄️ Supabase は PostgreSQL + 認証 + ストレージをフルマネージドで提供する BaaS です。  
> 無料プランで 500MB DB・50,000 MAU まで使えます。クレジットカード不要。

### 4.1 アカウント & プロジェクト作成

| 手順 | 操作内容 |
|------|---------|
| 1 | https://supabase.com にアクセスし「Start your project」をクリック |
| 2 | GitHub アカウントでサインイン（推奨） |
| 3 | 「New project」→ Organization は Personal |
| 4 | Project name：`tidebase` |
| 5 | Database Password：強力なパスワードを設定（**必ずメモしておく**） |
| 6 | Region：**Northeast Asia (Tokyo)** ← 必ず Tokyo を選択 |
| 7 | Free plan を選択して「Create new project」 |
| 8 | プロジェクトの初期化に 1〜2 分かかる。完了を待つ |

### 4.2 接続情報の取得

以下の2か所から値を取得する。

**① Project URL と DATABASE_URL**

```
ダッシュボード上部の電源ケーブルアイコン（Connect）にマウスオーバー
  ├─ Project URL        → SUPABASE_URL
  └─ Direct connection string → DATABASE_URL
```

> ⚠️ `DATABASE_URL` 内の `[YOUR-PASSWORD]` は Step 4.1 で設定した DB パスワードに手動で置き換えてください。

**② SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY**

```
左サイドバー「Project Settings」→「API Keys」
  ├─ anon / public  → SUPABASE_ANON_KEY
  └─ service_role   → SUPABASE_SERVICE_KEY（Reveal をクリックで表示）
```

> ⚠️ `service_role` キーはサーバー専用の秘密キーです。`.env` にのみ記載し、絶対に公開しないでください。

| 変数名 | 取得場所 | 説明 |
|--------|---------|------|
| `SUPABASE_URL` | Connect アイコン → Project URL | `https://xxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Project Settings → API Keys → anon/public | クライアント用公開キー |
| `SUPABASE_SERVICE_KEY` | Project Settings → API Keys → service_role | サーバー用秘密キー（**公開厳禁**） |
| `DATABASE_URL` | Connect アイコン → Direct connection string | PostgreSQL 接続文字列 |

### 4.3 初期テーブルの作成

Supabase ダッシュボード → SQL Editor → 「New query」で実行する。

**プロフィールテーブル**
```sql
-- プロフィールテーブル（auth.users と 1:1）
CREATE TABLE public.profiles (
  id           UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  username     TEXT UNIQUE,
  display_name TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- RLS（Row Level Security）を有効化
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 自分のプロフィールのみ読み書き可能
CREATE POLICY "profiles: own read"  ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles: own write" ON public.profiles FOR ALL    USING (auth.uid() = id);
```

**グループテーブル（Phase 2 で使用）**
```sql
CREATE TABLE public.groups (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
```

---

## Step 5 — 環境変数管理（.env ファイル）の設定

> Step 4 で取得した Supabase の接続情報をここで .env に設定します。  
> Step 6 以降のコードはこのファイルを参照します。

### 5.1 .env.example の作成

`.env.example`（CodeCommit にコミットする。実際の値は入れない）：

```bash
cat > .env.example << 'EOF'
# ================================
# TIDEBASE 環境変数テンプレート
# このファイルをコピーして .env を作成し、実際の値を入力してください
# .env は .gitignore に含まれており、CodeCommit にコミットされません
# ================================

# Supabase（Step 4 で取得した値を設定）
SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
SUPABASE_ANON_KEY=your_anon_key_here
SUPABASE_SERVICE_KEY=your_service_role_key_here
DATABASE_URL=postgresql://postgres:PASSWORD@db.YOUR_PROJECT_ID.supabase.co:5432/postgres

# AWS（Step 2 で設定したプロファイル名）
AWS_PROFILE=yuki
AWS_REGION=ap-northeast-1
S3_MEDIA_BUCKET=tidebase-media-dev

# 外部 API（Phase 1 で取得）
OPENWEATHER_API_KEY=your_key_here

# アプリ設定
ENVIRONMENT=development
SECRET_KEY=your_secret_key_here
EOF
```

### 5.2 .env の作成（ローカルのみ）

```bash
cp .env.example .env
# .env を開いて Step 4 で取得した実際の値を書き換える
```

**SECRET_KEY の生成**
```bash
openssl rand -hex 32
# → 出力された値を .env の SECRET_KEY に設定する
```

### 5.3 .env.example をコミット

```bash
git add .env.example
git commit -m "chore: add env template"
git push
```

---

## Step 6 — SAM（Lambda）ローカル環境構築

### 6.1 Python 仮想環境とパッケージのインストール

```bash
cd backend
python3.12 -m venv .venv
source .venv/bin/activate

# requirements.txt を作成
cat > requirements.txt << 'EOF'
fastapi==0.109.0
mangum==0.17.0
uvicorn==0.27.0
pydantic==2.5.3
httpx>=0.24.0,<0.25.0
supabase==2.0.3
python-dotenv==1.0.0
EOF

pip install -r requirements.txt
cd ..
```

### 6.2 SAM テンプレートの作成

`infrastructure/template.yaml`：

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: TIDEBASE API

Globals:
  Function:
    Timeout: 30
    MemorySize: 256
    Runtime: python3.12
    Environment:
      Variables:
        SUPABASE_URL: !Sub '{{resolve:ssm:/tidebase/dev/supabase_url}}'
        ENVIRONMENT: dev

Resources:
  TidebaseApiFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ../backend/
      Handler: app.main.handler
      Events:
        Api:
          Type: HttpApi
          Properties:
            Path: /{proxy+}
            Method: ANY

  # Supabase 自動停止防止（Step 8 で追記）

Outputs:
  ApiUrl:
    Description: API Gateway URL
    Value: !Sub 'https://${ServerlessHttpApi}.execute-api.${AWS::Region}.amazonaws.com'
```

### 6.3 env.json の作成（SAM ローカル実行用）

```bash
cat > env.json << 'EOF'
{
  "TidebaseApiFunction": {
    "SUPABASE_URL": "https://YOUR_PROJECT_ID.supabase.co",
    "SUPABASE_SERVICE_KEY": "your_service_role_key_here",
    "ENVIRONMENT": "development"
  }
}
EOF
```

> ⚠️ `env.json` は `.gitignore` に含まれています。実際の値を入れても CodeCommit にはコミットされません。

### 6.4 SAM ビルド & ローカル起動確認

```bash
cd infrastructure
sam build

# ローカルで API を起動
sam local start-api --env-vars ../env.json
# → http://localhost:3000 でアクセス可能（SAM は 3000 番ポート）
```

---

## Step 7 — FastAPI Hello World の実装と動作確認

### 7.1 Supabase クライアントの作成

`backend/app/db/client.py`：

```python
import os
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv('SUPABASE_URL')
SUPABASE_SERVICE_KEY = os.getenv('SUPABASE_SERVICE_KEY')

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
```

### 7.2 main.py の実装

`backend/app/main.py`：

```python
from fastapi import FastAPI
from mangum import Mangum
from app.db.client import supabase

app = FastAPI(
    title="TIDEBASE API",
    description="Your Fishing Knowledge Base",
    version="0.1.0"
)

@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "TIDEBASE"}

@app.get("/api/v1/test-db")
async def test_db():
    result = supabase.table("profiles").select("*").limit(1).execute()
    return {"db": "connected", "rows": len(result.data)}

# Lambda ハンドラー
handler = Mangum(app)
```

### 7.3 uvicorn でローカル起動

```bash
cd backend && source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
```

| URL | 内容 |
|-----|------|
| http://localhost:8000/health | ヘルスチェック → `{"status": "ok"}` |
| http://localhost:8000/api/v1/test-db | Supabase 接続テスト |
| http://localhost:8000/docs | SwaggerUI（自動生成 API ドキュメント） |
| http://localhost:8000/redoc | ReDoc |

### 7.4 コードを CodeCommit にプッシュ

```bash
cd ..   # プロジェクトルートに戻る
git add backend/app/ infrastructure/
git commit -m "feat: add FastAPI hello world and SAM template"
git push
```

---

## Step 8 — Supabase 自動停止防止 Lambda の設定

> ⚠️ Supabase 無料プランは **7日間アクセスがないとプロジェクトが自動停止**します。  
> 停止後 90日以内に復旧しないとデータが消滅します。  
> EventBridge + Lambda で毎日 1 回 ping するだけで完全に回避できます（追加コスト $0）。

### 8.1 仕組み

```
EventBridge（毎日 午前 6:00 JST）
  └─ Lambda（SupabasePingFunction）
        └─ GET https://{PROJECT_ID}.supabase.co/health
              └─ 200 OK → Supabase の停止タイマーがリセットされる
```

### 8.2 ping.py の実装

`backend/app/ping.py`：

```python
import os
import boto3
import httpx

def get_anon_key():
    ssm = boto3.client('ssm', region_name='ap-northeast-1')
    response = ssm.get_parameter(
        Name='/tidebase/dev/supabase_anon_key',
        WithDecryption=True
    )
    return response['Parameter']['Value']

def handler(event, context):
    """Supabase 自動停止防止 ping"""
    url = os.environ["SUPABASE_URL"] + "/rest/v1/"
    headers = {
        "apikey": get_anon_key()
    }
    try:
        res = httpx.get(url, headers=headers, timeout=10)
        print(f"Supabase ping: {res.status_code}")
        return {"status": res.status_code}
    except Exception as e:
        print(f"Supabase ping failed: {e}")
        raise
```

> `boto3` は Lambda 実行環境に標準で含まれているため `requirements.txt` への追加は不要です。

### 8.3 SAM テンプレートに追記

`infrastructure/template.yaml` の `Resources:` セクションのコメント行を以下で置き換える：

```yaml
  # Supabase 自動停止防止
  SupabasePingFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ../backend/
      Handler: app.ping.handler
      Description: Supabase 自動停止防止（毎日 6:00 JST 実行）
      Policies:
        - SSMParameterReadPolicy:
            ParameterName: tidebase/dev/supabase_anon_key
      Environment:
        Variables:
          SUPABASE_URL: !Sub '{{resolve:ssm:/tidebase/dev/supabase_url}}'
      Events:
        DailyPing:
          Type: Schedule
          Properties:
            Schedule: cron(0 21 * * ? *)   # UTC 21:00 = JST 06:00
            Name: supabase-daily-ping
            Enabled: true
```

> **cron の読み方**：EventBridge は UTC 基準。JST 06:00 = UTC 21:00（前日）。

### 8.4 SSM Parameter Store に Supabase URL を登録

SAM テンプレートの `{{resolve:ssm:...}}` 参照に必要なパラメータを登録する。

```bash
aws ssm put-parameter \
  --name "/tidebase/dev/supabase_url" \
  --value "https://YOUR_PROJECT_ID.supabase.co" \
  --type "String" \
  --profile yuki

aws ssm put-parameter \
  --name "/tidebase/dev/supabase_anon_key" \
  --value "your_anon_key_here" \
  --type "SecureString" \
  --profile yuki

aws ssm put-parameter \
  --name "/tidebase/dev/supabase_service_key" \
  --value "your_service_role_key_here" \
  --type "SecureString" \
  --profile yuki
```

### 8.5 ビルド & デプロイ

**初回は `--guided` を使って対話形式で設定する（`samconfig.toml` が自動生成される）**

```bash
cd infrastructure
sam build
sam deploy --guided --profile yuki
```

対話形式で以下を入力する：

```
Stack Name [sam-app]: tidebase-dev
AWS Region [us-east-1]: ap-northeast-1
Confirm changes before deploy [y/N]: y
Allow SAM CLI IAM role creation [Y/n]: Y
Disable rollback [y/N]: N
Save arguments to configuration file [Y/n]: Y
SAM configuration file [samconfig.toml]: samconfig.toml
SAM configuration environment [default]: dev
```

> `samconfig.toml` が生成されたら、`.gitignore` から除外して CodeCommit で管理することを推奨します。  
> 2回目以降は `sam deploy --profile yuki --stack-name tidebase-dev` だけで済みます。

> 初回デプロイ時は SAM が S3 バケット（デプロイ用）を自動作成します。完了まで 2〜3 分かかります。

**手動テスト（デプロイ直後）**

```bash
# Lambda 関数名を確認
aws lambda list-functions \
  --query "Functions[?starts_with(FunctionName, 'tidebase')].FunctionName" \
  --profile yuki

# 手動実行
aws lambda invoke \
  --function-name tidebase-dev-SupabasePingFunction-xxxx \
  --profile yuki \
  /tmp/ping_result.json

cat /tmp/ping_result.json
# → {"status": 200} が返れば成功
```

### 8.6 コードをプッシュ

```bash
cd ..
git add backend/app/ping.py infrastructure/template.yaml
git commit -m "feat: add Supabase auto-pause prevention Lambda"
git push
```

---

## Step 9 — 動作確認チェックリスト

以下のすべてにチェックが入れば **Phase 0 完了** です。

| # | 確認項目 | 確認方法 |
|---|---------|---------|
| 1 | Python 3.11 以上がインストールされている | `python3 --version` |
| 1a | git の user.name / user.email が設定されている | `git config --global --list` |
| 1b | git の defaultBranch が master に設定されている | `git config --global init.defaultBranch` |
| 2 | AWS CLI v2 がインストールされている | `aws --version` |
| 3 | SAM CLI がインストールされている | `sam --version` |
| 4 | Docker Desktop が起動している | `docker ps` |
| 5 | git-remote-codecommit がインストールされている | `pip show git-remote-codecommit` |
| 6 | IAM ユーザー `yuki` が作成されている | AWS マネコン → IAM |
| 7 | AWS CLI プロファイル `yuki` が設定されている | `aws sts get-caller-identity --profile yuki` |
| 8 | S3 バケット 2 つが作成されている | `aws s3 ls --profile yuki` |
| 9 | CodeCommit リポジトリ `TideBaseRepo` が作成されている | AWS マネコン → CodeCommit |
| 10 | ローカルにクローンされ初回コミットが入っている | `git log --oneline` |
| 11 | Supabase プロジェクトが作成されている（Tokyo） | Supabase ダッシュボード |
| 12 | profiles テーブルが作成され RLS が有効 | Supabase → Table Editor |
| 13 | .env ファイルに全変数が設定されている | `cat .env` |
| 14 | uvicorn で FastAPI が起動する | `http://localhost:8000/health` |
| 15 | SwaggerUI が表示される | `http://localhost:8000/docs` |
| 16 | Supabase への接続が成功する | `http://localhost:8000/api/v1/test-db` |
| 17 | ping Lambda がデプロイされている | AWS マネコン → Lambda |
| 18 | ping Lambda の手動実行が成功する（status: 200） | `aws lambda invoke ...` |

> 🚀 **Phase 0 完了後の次のステップ**  
> → Phase 1：潮汐 API の接続 + 釣果記録 API の実装（GET/POST）  
> → `tidebase.app` ドメインの取得（Route 53 で登録）

---

## 付録 — よく使う Makefile コマンド

```makefile
.PHONY: dev test sam-build sam-local deploy-dev install ping-supabase

dev:
	cd backend && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000

test:
	cd backend && source .venv/bin/activate && pytest tests/ -v

sam-build:
	cd infrastructure && sam build

sam-local:
	cd infrastructure && sam local start-api --env-vars ../env.json

deploy-dev:
	cd infrastructure && sam deploy \
	  --profile yuki \
	  --region ap-northeast-1 \
	  --stack-name tidebase-dev \
	  --capabilities CAPABILITY_IAM \
	  --resolve-s3

install:
	cd backend && python3.12 -m venv .venv \
	  && source .venv/bin/activate \
	  && pip install -r requirements.txt

ping-supabase:
	aws lambda invoke \
	  --function-name tidebase-dev-SupabasePingFunction-xxxx \
	  --profile yuki \
	  /tmp/ping_result.json && cat /tmp/ping_result.json
```

---

*TIDEBASE Phase 0 環境構築手順書 v2.0*
