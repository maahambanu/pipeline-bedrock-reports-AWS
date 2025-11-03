# Serverless AI-powered CI Reporting System
Turn raw CI artifacts (JUnit XML, SonarQube logs) into an **executive-ready email** after each pipeline run using **Amazon Bedrock (Titan Text Express)** and **Amazon SES**.

### **Architecture**
![my design](https://github.com/user-attachments/assets/64323163-5c96-4c69-8038-a34aa93b4c7e)


- **Cost-aware**: serverless & pay-per-use only (Bedrock tokens, Lambda ms, SES per email, S3 requests/storage, tiny SNS).
- **Pluggable**: works with any CI that can upload artifacts to S3 (GitLab, GitHub Actions, Jenkins, etc.).
- **Flexible**: group per folder/run (e.g., `test-results/vpc/`, `test-results/database/`) or consolidate to a single email.

---

## What this module does

1. Your CI uploads artifacts to S3:
   - `test-results/<run-or-stack>/*.xml` (JUnit/E2E/unit)
   - `sonarqube/<run-or-stack>/*.log` (code quality)
2. S3 **ObjectCreated** triggers **SNS**, which invokes **Lambda**.
3. Lambda aggregates relevant files (same `<run-or-stack>`), builds a prompt, calls **Amazon Titan Text Express** on **Bedrock**, and emails the summary to stakeholders through **SES**.

---

## Prerequisites

- AWS account with permissions to create/use: S3, SNS, Lambda, SES, Bedrock, CloudWatch Logs, IAM.
- **Regions**
  - Core stack (S3/SNS/Lambda/SES): choose one (e.g., `eu-west-1`).
  - Bedrock: ensure the model exists in your chosen region. Titan Text Express is available in **eu-west-1** and **eu-central-1** (use one and match IAM/ENV).
- **SES**: verify the **sender** identity; if SES is in **sandbox**, verify recipients or request production access.
- Node.js 18+ (if building locally).

---

## Quick start (Console-only, simplest)

> This is the fastest manual setup. CDK option is below.

### 1) Create S3 bucket
Create `banu-pipeline-reports` (or your name) in **your main region** (e.g., `eu-west-1`).  
Optional folders: `test-results/` and `sonarqube/`.

### 2) Create SNS topic
Create topic `ci-report-topic` in the same region.  
**Access policy** (allow this S3 bucket to publish):

```
json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowS3ToPublish",
    "Effect": "Allow",
    "Principal": {"Service": "s3.amazonaws.com"},
    "Action": "sns:Publish",
    "Resource": "arn:aws:sns:eu-west-1:<ACCOUNT_ID>:ci-report-topic",
    "Condition": {
      "ArnEquals": {"aws:SourceArn": "arn:aws:s3:::banu-pipeline-reports"},
      "StringEquals": {"aws:SourceAccount": "<ACCOUNT_ID>"}
    }
  }]
}
```
### 3) Configure S3 → SNS notifications
S3 → Bucket → Properties → Event notifications:
- **Add rule:** Events = All object create events; Prefix test-results/, Suffix .xml; Destination = your SNS topic.
- **Add rule:** Events = All object create events; Prefix sonarqube/, Suffix .log; Destination = your SNS topic.

### 4) Create IAM role for Lambda
- **Role name:** ci-report-reporter-role (trusted entity: Lambda).
- **Attach:**
  - AWSLambdaBasicExecutionRole
  - S3 read (least-privilege inline):
```
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::banu-pipeline-reports",
      "Condition": { "StringLike": { "s3:prefix": ["test-results/*","sonarqube/*"] } } },
    { "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": [
        "arn:aws:s3:::<S3-bucket-name>/test-results/*",
        "arn:aws:s3:::<S3-bucket-name>/sonarqube/*"
    ] }
  ]
}
```
- SES send (inline):
```
  { "Version": "2012-10-17",
  "Statement": [{ "Effect":"Allow", "Action":["ses:SendEmail","ses:SendRawEmail"], "Resource":"*" }]
}
```
- Bedrock invoke (inline) – pick your Bedrock region and model ID:
```
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],
    "Resource": "arn:aws:bedrock:eu-west-1::foundation-model/amazon.titan-text-express-v1"
  }]
}
```
### 5) Create Lambda function
- **Runtime:** Node.js 18.x
- **Handler:** index.handler (we’ll upload a single file called index.mjs and export handler).
- **Execution role:** ci-report-reporter-role.
- Code (Lambda → Upload from → .zip or inline editor)  →  ``` lambda/index.mjs.  ```
- Inline editor notes.
  - Ensure package.json in Lambda has: ```{ "type": "module" }```
  - Runtime settings → Handler:  ``` index.handler  ```
- **Environment variables:**
  - ARTIFACT_BUCKET = <S3-bucket-name>
  - RECIPIENT_EMAILS = you@example.com
  - SENDER_EMAIL = you@example.com
  - EMAIL_SUBJECT_PREFIX = [CI]
  - BEDROCK_MODEL_ID = amazon.titan-text-express-v1
  - BEDROCK_REGION = eu-west-1 (or your chosen Bedrock region, match IAM)
  - SES_REGION = eu-west-1
- **Subscribe Lambda to SNS**
  - SNS → Topic → Create subscription → Protocol Lambda → pick your function → Confirmed.

### 6) Test (no pipeline needed)
- Lambda → Test → create a test event:
```
{
  "Records": [
    {
      "Sns": {
        "Message": "{\"Records\":[{\"s3\":{\"bucket\":{\"name\":\"<S3-bucket-name>\"},\"object\":{\"key\":\"test-results/vpc/unit.xml\"}}}]}"
      }
    }
  ]
}
```
- You should receive an email.
> CloudWatch Logs show “Bedrock OK …” and “SES result …” or any error to fix.

### CI integration (example: GitLab)
- Add the following job in your pipeline
```
upload_reports:
  stage: post
  image: amazon/aws-cli:2
  script:
    - aws s3 cp junit.xml s3://<S3-bucket-name>/test-results/$CI_PIPELINE_ID/junit.xml --region eu-west-1
    - aws s3 cp sonar.log s3://<S3-bucket-name>/sonarqube/$CI_PIPELINE_ID/sonar.log --region eu-west-1
  rules:
    - if: $CI_COMMIT_BRANCH
```
- This will automatically trigger the module and send the email.

### CDK deployment (optional, infra-as-code)
If you prefer IaC, use the included CDK stack (infra/):
- infra/lib/ci-reporting-stack.ts provisions SNS, Lambda, event notifications, IAM, etc.
- Configure props in infra/bin/app.ts: ```recipientEmails```, ```senderEmail```, ```artifactBucketName```, ```bedrockRegion```, ```bedrockModelId```, ```sesRegion```.
- Commands:
```
npm i -g aws-cdk
cd infra
npm i
cdk bootstrap
cdk synth
cdk deploy
```
### Replay existing artifacts
Old files won’t trigger S3 events. Three easy ways:
- Lambda Test (recommended): create test events with the keys you want.
- SNS → Publish message: paste the same JSON the Lambda expects (SNS-wrapped S3 event).
- CLI direct invoke
```
aws lambda invoke --region eu-west-1 \
  --function-name ci-report-reporter \
  --payload fileb://payload.json out.json
```
- payload.json:
```
{
  "Records": [
    {
      "Sns": {
        "Message": "{\"Records\":[{\"s3\":{\"bucket\":{\"name\":\"banu-pipeline-reports\"},\"object\":{\"key\":\"test-results/vpc/unit.xml\"}}}]}"
      }
    }
  ]
}
```
### Operational tips
- **CloudWatch Logs:** set retention (e.g., 14 days) to control cost.
- **S3:** lifecycle rules for test-results/ / sonarqube/ if you don’t need long-term retention.
- **SES:** production access lets you email any address.
- **Bedrock:** charges only on invocation tokens (no idle cost).

### Troubleshooting
- No email
  - Check Lambda logs first.
  - SES sandbox? Verify recipient or request production.
  - SES_REGION mismatch with identity region.
- Bedrock access denied
  - IAM policy region/ARN must match BEDROCK_REGION & model ID.
  - Example ARN: arn:aws:bedrock:eu-west-1::foundation-model/amazon.titan-text-express-v1
- Import/ESM errors
  - Ensure package.json has "type": "module" and handler is index.handler.





