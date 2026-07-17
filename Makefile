.PHONY: dev test sam-build sam-local deploy-dev install

install:
	cd backend && python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt

dev:
	cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000

test:
	cd backend && .venv/bin/pytest tests/ -v

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
