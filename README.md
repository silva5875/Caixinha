# Caixa — backend de Open Finance (Pluggy)

Backend mínimo que conecta seus bancos via **Pluggy** e devolve contas e transações
para o app Caixa. São duas rotas serverless:

- `POST /api/connect-token` — emite o token curto que abre o widget de conexão.
- `GET /api/sync?itemId=...` — lê contas e transações do banco conectado.

A chave secreta do Pluggy fica **só no servidor**, nunca no app.

---

## 1. Criar a conta no Pluggy

1. Entre em https://dashboard.pluggy.ai e crie uma conta.
2. Crie uma **application**. Ela gera um `CLIENT_ID` e um `CLIENT_SECRET`.
   O `CLIENT_SECRET` aparece **uma única vez** — copie e guarde.
3. Aplicações novas já vêm com os conectores de **Sandbox** (bancos fictícios),
   então dá pra testar tudo antes de ligar num banco real.

## 2. Publicar o backend na Vercel (grátis)

Jeito mais simples, pelo site:

1. Suba esta pasta (`caixa-backend`) para um repositório no GitHub.
2. Em https://vercel.com, clique em **Add New → Project** e importe esse repositório.
3. Em **Environment Variables**, adicione (valores do passo 1 e um token aleatório):
   - `PLUGGY_CLIENT_ID`
   - `PLUGGY_CLIENT_SECRET`
   - `APP_TOKEN` (ex.: gere com `openssl rand -hex 24`)
   - `ALLOWED_ORIGIN` (opcional — o domínio do seu app)
4. **Deploy**. Você recebe uma URL como `https://caixa-backend.vercel.app`.

Pela linha de comando (alternativa):

```bash
npm i -g vercel
cd caixa-backend
vercel          # primeiro deploy
vercel env add PLUGGY_CLIENT_ID
vercel env add PLUGGY_CLIENT_SECRET
vercel env add APP_TOKEN
vercel --prod   # publica
```

## 3. Testar rápido

```bash
# deve responder { "accessToken": "..." }
curl -X POST https://SEU-BACKEND.vercel.app/api/connect-token \
  -H "Authorization: Bearer SEU_APP_TOKEN"
```

## 4. Ligar no app Caixa

No app, abra o menu ≡ → **Open Finance** → **Configurar servidor** e preencha:

- **URL do servidor:** `https://SEU-BACKEND.vercel.app`
- **Token do app:** o mesmo valor de `APP_TOKEN`

Depois toque em **Conectar banco**. O widget do Pluggy abre, você escolhe o banco
(ou um sandbox para testar), e ao terminar o app importa contas e transações.
Toque em **Sincronizar agora** sempre que quiser puxar as novidades.

---

### Notas

- **Sandbox:** no widget, procure por conectores "Pluggy Bank" / "Sandbox" para testar
  sem conectar um banco de verdade.
- **Atualização:** em conectores de Open Finance, novas transações podem levar
  algumas horas para aparecer; o app sempre lê os últimos 12 meses por padrão.
- **Custo:** a Sandbox e o ambiente de desenvolvimento são gratuitos (limite de itens).
  Conexões reais em produção podem ter custo — confira os planos atuais no site do Pluggy.
- **Segurança:** o `APP_TOKEN` fica visível em quem usa o app no navegador. Para uso
  pessoal está ok; se for abrir para mais gente, troque por um login de verdade.
