'use strict';

// Every line bound for an Atris model passes redactOutgoing. These are fake
// secrets in every common shape: each one must be hidden. The second list
// is ordinary code that only names a secret: none of it may be hidden.

const test = require('node:test');
const assert = require('node:assert');
const { redactOutgoing, strictSecretHit } = require('../lib/sentinel-cloud');

// Fake keys are written in pieces so the code host's secret scanner does
// not take them for real ones. Joined, each has the real shape.
const j = (...parts) => parts.join('');

const SECRETS = [
  // a numbered source line, the way a prompt shows code
  '   12  DB_PASSWORD=numberedPw1',
  // connection strings
  'DATABASE_URL=postgres://admin:hunter2pass@db.internal:5432/prod',
  'const url = "postgresql://app_user:Pa55w0rd-prod@10.0.0.4/app";',
  'MONGO_URI="mongodb+srv://svc:Qz7mongoPass@cluster0.abcde.mongodb.net/db"',
  'redis_url: redis://:r3disS3cret@cache.local:6379/0',
  'REDIS_URL=rediss://default:AbC123redis@redis.example.net:6380',
  'mysql://root:toor1234@localhost:3306/shop',
  'amqp://guest:rabbitPw9@mq:5672/',
  'jdbc:postgresql://db:5432/app?user=app&password=jdbcPw55',
  'Server=tcp:sql.local,1433;Database=app;User Id=sa;Password=SqlPw!2024;',
  'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=Zm9vYmFyYmF6cXV4;EndpointSuffix=core.windows.net',
  'conn = psycopg2.connect("dbname=app user=app password=pgPw7788 host=db")',
  // assignments named like a password or key
  'DATABASE_PASSWORD = "Pa55w0rd-prod"',
  'DATABASE_PASSWORD=Pa55w0rd-prod',
  'export DB_PASSWORD=s3cretDbPw',
  'db_password: hunter2pass',
  '  password: Welcome2024',
  '"password": "pr0d-db-pw"',
  '{"db_password": "pr0d-db-pw", "user": "app"}',
  "    'password' => 'phpDbPw77',",
  ':password => "rubyPw88",',
  'password = "ini_pw_123"',
  'password=iniPw123',
  'POSTGRES_PASSWORD: example-pw-1',
  '  - POSTGRES_PASSWORD=postgres',
  'MYSQL_ROOT_PASSWORD=rootpw',
  j('AWS_SECRET_ACCESS_KEY=', 'wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYzzzzzzzzzz'),
  'aws_secret_access_key = abcdEFGHijklMNOP1234',
  'SECRET_KEY = "django-insecure-0abc!def"',
  'secret_key_base: 9f8e7d6c5b4a',
  'client_secret: "oauthClientSecret1"',
  'const apiKey = "k-12345abcde";',
  'api_key="sk-short-1"',
  'GITHUB_TOKEN=gho_short123',
  'STRIPE_SECRET=whatever99',
  'Password: "goStructPw1",',
  'private static final String DB_PASS = "javaPw123";',
  'cfg.password = "attrPw456"',
  'connect(host="db", user="app", password="kwargPw789")',
  '<add key="DbPassword" value="x" password="xmlPw4321" />',
  'SENTRY_DSN=https://abc123@o0.ingest.sentry.io/1',
  'passphrase: "correct-horse-1"',
  // headers and command lines
  'Authorization: Basic dXNlcjpwYXNz',
  'headers["Authorization"] = "Bearer abc123def456ghi"',
  'mysql -u root -pRootPw123 shop',
  'pg_dump --password=dumpPw44 app',
  'curl -u admin:curlPw55 https://api.local/',
  'sshpass -p sshPw66 ssh host',
  'PGPASSWORD=psqlPw77 psql -h db',
  'machine api.local login me password netrcPw88',
  // keys and cloud tokens
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  '-----BEGIN EC PRIVATE KEY-----',
  'PuTTY-User-Key-File-3: ssh-ed25519',
  j('AKIA', 'ABCDEFGHIJKLMNOP'),
  'token = "glpat-abcdefghij1234567890"',
  'HF_TOKEN=hf_abcdefghijklmnopqrstuvwxyz1234',
  j('STRIPE=sk_', 'test_', 'abcdefghijklmnopqrst1234'),
  'whsec_abcdefghijklmnopqrstuv12',
  j('TWILIO=AC', '0123456789abcdef', '0123456789abcdef'),
  'ya29.a0AfH6SMBabcdefghijklmnopq',
  'GOCSPX-abcdefghijklmnopqrstuv',
  '"type": "service_account",',
];

const NORMAL = [
  'const password = req.body.password;',
  'password = os.environ["DB_PASSWORD"]',
  'DB_PASSWORD = os.getenv("DB_PASSWORD")',
  'password: process.env.DB_PASSWORD,',
  'const apiKey = process.env.OPENAI_API_KEY;',
  'url = f"postgres://{user}:{password}@{host}/{db}"',
  'const url = `postgres://${user}:${pass}@${host}/db`;',
  'DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@db:5432/app',
  'password: ${DB_PASSWORD}',
  'password: $DB_PASSWORD',
  'token: ${{ secrets.GITHUB_TOKEN }}',
  "secret_key_base: <%= ENV['SECRET_KEY_BASE'] %>",
  'password = None',
  'password: string;',
  'token?: string;',
  'apiKey: Optional[str] = None',
  'password = getpass.getpass()',
  'self.api_key = api_key',
  'password = new_password',
  'if (password === "") return;',
  '<input type="password" name="password" placeholder="Password">',
  '"password": "Password",',
  '"forgot_password": "Forgot your password?",',
  'resetPassword: "/reset-password",',
  'const TOKEN_ENV = "GITHUB_TOKEN";',
  'API_KEY_NAME = "OPENAI_API_KEY"',
  'password_reset_url = "/accounts/reset"',
  'passwordLabel: "Enter a password",',
  'tokenType: "bearer",',
  'const hash = await bcrypt.hash(password, 10);',
  'def check_password(self, raw_password):',
  'if not verify(token, secret):',
  'headers["Authorization"] = `Bearer ${token}`',
  'git clone https://github.com/acme/widgets.git',
  'https://user@example.com/path',
  'redis://localhost:6379/0',
  'postgres://db:5432/app',
  'mailto:help@example.com',
  'curl -u "$USER:$PASS" https://api.local/',
  'mysql -u root -p shop',
  'app.listen(3000, () => console.log("ready"));',
  'for (const key of Object.keys(obj)) total += obj[key];',
  'module.exports = { password, token };',
  'const { password, ...rest } = user;',
  'return jwt.sign({ id }, secret, { expiresIn: "1h" });',
  '  starting paths: src/components/dashboard/widgets/charts/LineChart.jsx',
  '# Set DATABASE_PASSWORD in your .env file before you run this',
];

test('every common secret shape is hidden before it leaves for an Atris model', () => {
  const missed = SECRETS.filter((line) => redactOutgoing(line).hidden !== 1);
  assert.deepStrictEqual(missed, [], 'these secret lines would have been sent');
});

test('the same secrets are hidden when they arrive JSON-escaped inside a prompt', () => {
  const missed = SECRETS.filter((line) => {
    const escaped = JSON.stringify({ code: line }).slice(1, -1);
    const out = redactOutgoing(`look at this:\n${escaped}\nend`);
    return out.hidden < 1 || out.text.includes(escaped) || !out.text.startsWith('look at this:');
  });
  assert.deepStrictEqual(missed, []);
});

test('ordinary code that only names a secret is never hidden', () => {
  const hidden = NORMAL.filter((line) => redactOutgoing(line).hidden !== 0);
  assert.deepStrictEqual(hidden, [], 'these normal lines were hidden');
});

test('upload text and record entries refuse the same shapes', () => {
  assert.strictEqual(strictSecretHit('Set DATABASE_PASSWORD = "Pa55w0rd-prod" in the config.'), true);
  assert.strictEqual(strictSecretHit('The login form sends the password in plain text.'), false);
});
