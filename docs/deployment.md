# Deploying to AWS

Fórmula ½ is a static site: there is no backend, database or build. It is published on **S3 + CloudFront** and
GitHub Actions uploads it on every push to `main`.

## What happens on every push to `main`

`.github/workflows/deploy.yml`:

1. **Build the site**: `tools/site.sh` copies to `site/` only what the browser loads: `index.html`, `src/`,
   `tracks/`, `cars/` and `models/` (the files in git; `rl/`, `tools/` and `serve.py` are left out).
2. **Upload to S3**: `aws s3 sync --delete`, with `Cache-Control: no-cache`. The files have no hash in their names,
   so the browser always asks whether they changed (if not, the response is an empty 304) and nobody ends up with a
   mix of versions.
3. **Invalidate CloudFront** (`/*`), so the CloudFront edge locations stop serving the old version.

AWS authenticates with **OIDC** (a role the workflow assumes): no AWS keys are stored in GitHub.

The names are at the top of the workflow; if you change them, change them in the template too:

```yaml
AWS_REGION: sa-east-1
S3_BUCKET: formula-medio
```

## One time only: the infrastructure

The commands use `--profile personal`: on this machine the `default` profile is the work account. Before creating
anything, `aws sts get-caller-identity --profile personal` must show account `437954864254`.

Everything is in `infra/aws.yml` (CloudFormation): the private bucket, the CloudFront distribution (the only thing
that can read the bucket, with Origin Access Control, gzip/brotli and all regions, including South America) and the
deploy role.

1. **Does the account already have the GitHub OIDC provider?** (sleepmon uses it, so probably yes). An account can
   have only one, so if it exists its ARN has to be passed to the template:

   ```bash
   aws iam list-open-id-connect-providers --profile personal
   ```

   If one ending in `token.actions.githubusercontent.com` shows up, that is the ARN.

2. **Create everything** (takes a few minutes, mostly CloudFront). With the existing provider:

   ```bash
   aws cloudformation deploy --profile personal --region sa-east-1 --stack-name formula-medio \
     --template-file infra/aws.yml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides GitHubOIDCProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com
   ```

   If the account doesn't have it, the same command without `--parameter-overrides` creates it.

   The bucket name must be unique across all of S3: if `formula-medio` is taken, add `BucketName=<other>` to
   `--parameter-overrides` and change `S3_BUCKET` in the workflow.

3. **See what was created**:

   ```bash
   aws cloudformation describe-stacks --profile personal --region sa-east-1 --stack-name formula-medio \
     --query "Stacks[0].Outputs" --output table
   ```

   - `SiteUrl`: where the game is (`https://xxxx.cloudfront.net`).
   - `DeployRoleArn` and `DistributionId`: for the GitHub secrets.

## GitHub secrets

In the repo, Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `AWS_ROLE_ARN` | `DeployRoleArn` from the template |
| `CLOUDFRONT_DISTRIBUTION_ID` | `DistributionId` from the template |

Then, the first deploy: a push to `main`, or Actions → Deploy → Run workflow.

The role can only be assumed by a workflow running on `main` of `jpurplefox/formula-medio` (other branches or forks
can't publish). GitHub identifies the repo by its IDs (`repo:jpurplefox@9813325/formula-medio@1453280176`, the format
for new repos, which doesn't change if the repo is renamed); if the repo changes, the new value comes from
`gh api repos/<owner>/<repo>/actions/oidc/customization/sub` (`sub_claim_prefix`) and goes in the template's
`GitHubSubjectPrefix` parameter. If the deploy fails with *Not authorized to perform sts:AssumeRoleWithWebIdentity*,
this is almost certainly the cause.

## Optional

- **Custom domain**: an ACM certificate **in `us-east-1`** (CloudFront only takes them from there), and in the
  distribution, the domain under *Alternate domain names* with that certificate. Then, in DNS, a record pointing to
  the distribution (in Route 53, an alias).
- **Spending alert**: a budget in AWS Budgets with an email alert. With this traffic the cost is cents; what weighs
  most is what each player downloads the first time (a few MB: the rivals' network, compressed, and the tracks).

## Testing the built site locally

```bash
tools/site.sh && python3 -m http.server -d site 8124
```

(or, from Claude Code, the `site` configuration in `.claude/launch.json`).
