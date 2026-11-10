# Deploy en AWS

Fórmula ½ es un sitio estático: no hay backend, base de datos ni build. Se publica en **S3 + CloudFront** y lo sube
GitHub Actions en cada push a `main`.

## Qué pasa en cada push a `main`

`.github/workflows/deploy.yml`:

1. **Armar el sitio**: `tools/site.sh` copia a `site/` sólo lo que carga el navegador: `index.html`, `src/`,
   `tracks/`, `cars/` y `models/` (los archivos de git; `rl/`, `tools/` y `serve.py` quedan afuera).
2. **Subir a S3**: `aws s3 sync --delete`, con `Cache-Control: no-cache`. Los archivos no llevan un hash en el nombre,
   así que el navegador pregunta siempre si cambiaron (si no, la respuesta es un 304 vacío) y nadie queda con una mezcla
   de versiones.
3. **Invalidar CloudFront** (`/*`), para que los puntos de CloudFront dejen de servir lo anterior.

AWS se autentica con **OIDC** (un rol que asume el workflow): no hay claves de AWS guardadas en GitHub.

Los nombres están arriba de todo en el workflow; si los cambiás, cambialos también en la plantilla:

```yaml
AWS_REGION: sa-east-1
S3_BUCKET: formula-medio
```

## Una sola vez: la infraestructura

Los comandos van con `--profile personal`: en esta máquina el perfil `default` es la cuenta del trabajo. Antes de
crear nada, `aws sts get-caller-identity --profile personal` tiene que decir la cuenta `437954864254`.

Todo está en `infra/aws.yml` (CloudFormation): el bucket privado, la distribución de CloudFront (la única que puede
leer el bucket, con Origin Access Control, gzip/brotli y todas las regiones, incluida Sudamérica) y el rol de deploy.

1. **¿La cuenta ya tiene el proveedor OIDC de GitHub?** (sleepmon lo usa, así que probablemente sí). Una cuenta puede
   tener uno solo, así que si existe hay que pasarle su ARN a la plantilla:

   ```bash
   aws iam list-open-id-connect-providers --profile personal
   ```

   Si aparece uno que termina en `token.actions.githubusercontent.com`, ese es el ARN.

2. **Crear todo** (tarda unos minutos, sobre todo CloudFront). Con el proveedor que ya existe:

   ```bash
   aws cloudformation deploy --profile personal --region sa-east-1 --stack-name formula-medio \
     --template-file infra/aws.yml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides GitHubOIDCProviderArn=arn:aws:iam::<cuenta>:oidc-provider/token.actions.githubusercontent.com
   ```

   Si la cuenta no lo tiene, el mismo comando sin `--parameter-overrides` lo crea.

   El nombre del bucket tiene que ser único en todo S3: si `formula-medio` está tomado, agregá
   `BucketName=<otro>` a `--parameter-overrides` y cambiá `S3_BUCKET` en el workflow.

3. **Ver lo que salió**:

   ```bash
   aws cloudformation describe-stacks --profile personal --region sa-east-1 --stack-name formula-medio \
     --query "Stacks[0].Outputs" --output table
   ```

   - `SiteUrl`: dónde queda el juego (`https://xxxx.cloudfront.net`).
   - `DeployRoleArn` y `DistributionId`: para los secrets de GitHub.

## Secrets de GitHub

En el repo, Settings → Secrets and variables → Actions:

| Secret | Valor |
| --- | --- |
| `AWS_ROLE_ARN` | `DeployRoleArn` de la plantilla |
| `CLOUDFRONT_DISTRIBUTION_ID` | `DistributionId` de la plantilla |

Después, el primer deploy: un push a `main`, o Actions → Deploy → Run workflow.

El rol sólo lo puede asumir un workflow que corre en `main` de `jpurplefox/formula-medio` (lo de otras ramas o forks
no puede publicar). GitHub identifica al repo con sus IDs (`repo:jpurplefox@9813325/formula-medio@1453280176`, el
formato de los repos nuevos, que no cambia si se renombra); si el repo cambia, el valor nuevo sale de
`gh api repos/<dueño>/<repo>/actions/oidc/customization/sub` (`sub_claim_prefix`) y va en el parámetro
`GitHubSubjectPrefix` de la plantilla. Si el deploy falla con *Not authorized to perform sts:AssumeRoleWithWebIdentity*,
casi seguro es esto.

## Opcional

- **Dominio propio**: un certificado de ACM **en `us-east-1`** (CloudFront sólo los toma de ahí), y en la
  distribución, el dominio en *Alternate domain names* con ese certificado. Después, en el DNS, un registro que apunte
  a la distribución (en Route 53, un alias).
- **Alerta de gastos**: un presupuesto en AWS Budgets con aviso por mail. Con este tráfico el costo es de centavos;
  lo que más pesa es lo que baja cada jugador la primera vez (unos pocos MB: la red de los rivales, comprimida, y los
  circuitos).

## Probar el sitio armado en local

```bash
tools/site.sh && python3 -m http.server -d site 8124
```

(o, desde Claude Code, la configuración `site` de `.claude/launch.json`).
