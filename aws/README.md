# AWS: the server's S3 bucket

The server's one S3 bucket (decision B14) and the IAM user it reads and writes it
with, as a Terraform root module. Each environment gets its own bucket and IAM user,
named from the `environment` variable, and its own state.

| Path | What it is |
|---|---|
| [`terraform/s3.tf`](terraform/s3.tf) | The bucket: owner-enforced (no ACLs), public access blocked, SSE-S3, TLS-only bucket policy, a lifecycle rule that aborts stale multipart uploads, optional versioning |
| [`terraform/iam.tf`](terraform/iam.tf) | The server's IAM user, its inline policy, and its access key |
| [`terraform/outputs.tf`](terraform/outputs.tf) | Bucket name, region, the key pair, and `server_env`: the four `.env` lines |
| [`terraform/variables.tf`](terraform/variables.tf) | `environment` (required) and the optional overrides; `terraform.tfvars.example` lists them |

What lives in the bucket: roster CSV uploads and rejected-row exports under
`agency-ingest/<tenant>/` (contact lists, so PII), and the abandon clips. The server
uploads and streams every object itself, so the bucket needs no CORS and no public
access.

## Names

| Resource | Name |
|---|---|
| Bucket | `<name_prefix>-<environment>-<account id>`, e.g. `magick-agency-staging-123456789012` (S3 names are global; the account id keeps them unique). `bucket_name` overrides it |
| IAM user | `<name_prefix>-<environment>-server`, under path `/<name_prefix>/` |

Every resource is tagged `Project`, `Environment`, `ManagedBy = terraform` and
`Module = aws/terraform`, plus `extra_tags`.

## Apply

AWS credentials come from the usual chain: `AWS_PROFILE`, SSO, or env keys. The
identity applying needs to create S3 buckets, IAM users, user policies and access
keys. Nothing here talks to AWS until `plan`.

```bash
cd aws/terraform
cp terraform.tfvars.example dev-manas.tfvars      # set environment = "dev-manas"
terraform init
terraform workspace new dev-manas                 # once per environment; later: terraform workspace select dev-manas
terraform plan  -var-file=dev-manas.tfvars
terraform apply -var-file=dev-manas.tfvars
{ echo; terraform output -raw server_env; echo; } >> ../../apps/server/.env
```

The `echo`s matter: `-raw` prints no trailing newline, so a bare `>>` joins the next line
appended to the file onto `AWS_SECRET_ACCESS_KEY=`. If `.env` already has `S3_AUDIO_BUCKET` or
`AWS_*` lines, remove them first: dotenv silently takes the last copy of a key.

Restart the server. It logs `S3 client initialized` with the bucket name.

**One workspace per environment, and it must match.** State is local and per
workspace (`terraform.tfstate.d/<environment>/`, gitignored). The bucket carries a
precondition that the selected workspace equals `environment`, so `staging.tfvars`
applied in the `dev-manas` workspace fails at plan instead of renaming dev's bucket.
Apply an environment from the machine that holds its state, or copy the state
across.

**The state holds the server's secret access key.** `aws_iam_access_key` stores the
secret in state, which is why state, plans and `*.tfvars` are all gitignored. To
rotate the key: `terraform apply -replace='aws_iam_access_key.server[0]' -var-file=…` (quoted: zsh
reads the brackets as a glob),
update the server's env, restart. With `create_access_key = false` no key is made;
create one outside Terraform and give it to the server yourself.

## The server's permissions

The inline policy allows exactly what `apps/server/src/storage/s3.ts` calls:

| Action | Resource | For |
|---|---|---|
| `s3:PutObject` | `<bucket>/*` | `uploadFile`: CSV uploads, rejected-row exports |
| `s3:GetObject` | `<bucket>/*` | `getFile`, `getFileStream`, presigned GETs, and `headFile` (HeadObject is authorised by GetObject) |
| `s3:ListBucket` | `<bucket>` | A missing object answers 404 instead of 403 |

There is no delete permission, because nothing calls `deleteFile` or
`deleteByPrefix` today. The first caller adds `s3:DeleteObject` in
`terraform/iam.tf`; it also authorises the batch `DeleteObjects` call.

## Settings worth deciding per environment

- `force_destroy`: false by default, so `terraform destroy` refuses a bucket that
  still holds objects. Set true only for a throwaway dev bucket.
- `noncurrent_version_expiration_days`: 0 leaves versioning off. A positive value
  turns it on and keeps replaced or deleted versions that many days, which protects
  against an accidental overwrite at the cost of keeping old contact lists longer.
  Going back to 0 later only **suspends** versioning and drops the expiry rule: the
  versions already kept stay forever. Delete them first (expire them with a positive
  value until they are gone, or purge them in the console), then set 0.
- **No expiry on current objects.** Uploaded contact lists stay until something
  deletes them. Whether they should expire, and after how long, is a retention
  decision that this module does not make.
