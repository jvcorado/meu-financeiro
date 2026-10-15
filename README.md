# Meu financeiro — contas e sincronização

Aplicativo independente de planejamento financeiro, desenvolvido a partir da análise visual do App do Breno. Não possui vínculo com o serviço original. A interface segue o calendário horizontal, a navegação, os painéis e as cores da referência. Dados iniciais são inteiramente fictícios.

## Abrir

Com o servidor em execução, acesse **http://127.0.0.1:4173/login**.

Para executar no Linux, macOS ou Windows com Python instalado:

```sh
python3 -B server.py --port 4173
```

No macOS, também é possível abrir `iniciar.command`. Depois, acesse o endereço acima e clique em **criar conta**. Não há e-mail ou senha padrão.

Requer Python 3.11+ com `hashlib.scrypt`. O iniciador usa o Python completo do Codex como alternativa quando o Python do macOS não oferece esse recurso. Não é necessário instalar pacotes. A fonte DM Sans está incluída localmente, com licença em `assets/fonts/OFL.txt`.

## Implementado

- Saldos com 12 meses, navegação temporal, retorno a hoje, colunas recolhíveis, totais por categoria e check-ins.
- Horizonte com os mesmos saldos calculados, cores e consulta por dia.
- Entradas, saídas, diários, economias e cartão; cadastro contextual, detalhes, edição e exclusão.
- Repetições diárias, semanais e mensais, duração finita ou aberta, parcelamento com conservação de centavos.
- Alteração/exclusão de uma ocorrência, desta e futuras ou de toda a série.
- Painel de movimentações por dia, mês ou tag, com filtros de categoria e navegação.
- Totais mensais e anuais: performance, economizado, custo de vida e diário médio.
- Tags com oito cores, busca, limite de 100 e cinco regras independentes de cálculo.
- Cartões com fechamento/vencimento e sugestão de data financeira.
- Previsão diária com itens mensais e divisor de 28–31 dias.
- Perfil da conta, tema claro/escuro/sistema, ajuda, sugestões armazenadas na conta e limpeza do planejamento com confirmação.
- Cadastro, login, saída, sessões persistentes, troca de senha e recuperação por e-mail quando SMTP estiver configurado.
- Dados isolados por conta, senhas com scrypt, cookies HttpOnly e proteção CSRF.
- Sincronização entre sessões no mesmo servidor, combinação de alterações independentes e revisão explícita dos conflitos.
- Persistência em SQLite, validação no servidor e revisões atômicas.

## Dados e arquitetura

O banco fica em `data/app.sqlite` e é mantido ao reiniciar. Banco, backups e credenciais não fazem parte deste repositório. Nenhuma conta é criada automaticamente.

No **primeiro cadastro local**, marque “Trazer o planejamento já salvo neste computador para minha conta” se quiser continuar os dados anteriores. A importação é opcional e mantém o legado intacto. As demais contas começam vazias. As credenciais do serviço original não estão conectadas a esta recriação.

`app.mjs` controla a interface; `auth-ui.mjs` contém telas de acesso; `domain.mjs` contém cálculos; `sync.mjs` combina versões; `server.py` e `auth.py` fornecem API, autenticação e armazenamento. O SQLite guarda um documento de planejamento por conta, além de usuários, sessões e recuperações.

O servidor local escuta em `127.0.0.1`. Para acesso entre dispositivos pela internet, publique uma única instância com HTTPS e banco persistente. A configuração e os modelos estão em [DEPLOY.md](DEPLOY.md). Nenhuma hospedagem foi contratada ou publicada. SMTP ainda precisa ser configurado para enviar recuperação de senha.

A sincronização ocorre a cada 5segundos e ao retornar à aba. Formulários abertos são preservados quando chega outra versão. Sem conexão, tente salvar novamente mantendo o formulário aberto; fechar ou recarregar descarta rascunhos. Não existe fila offline persistente.

## Regras assumidas nesta implementação

- Uma tag que manda ignorar prevalece sobre tags que mandam calcular, para cada indicador.
- Previsão e diário já agendado no futuro são somados.
- Parcelas distribuem centavos restantes nas primeiras ocorrências.
- Séries iniciadas no dia 31 usam o último dia em meses curtos e retomam a âncora 31 depois.
- Compras no próprio dia de fechamento permanecem no ciclo que fecha naquele dia.
- Editar toda a série limpa exceções anteriores; editar futuras limpa exceções daquele trecho. Uma edição individual não redistribui outras parcelas.
- A edição do valor de uma ocorrência para toda a série usa o novo valor por ocorrência. Alterar só a descrição mantém o total e os centavos originais.
- Sem entradas, o percentual economizado aparece como “—”.
- A média mensal corrente usa dias decorridos; a tela anual usa todos os dias do mês, mantendo a diferença observada na referência.

Essas escolhas resolvem pontos que não puderam ser testados no sistema original. A análise do serviço original não faz parte deste repositório; estas regras documentam as decisões desta implementação.

## Validação

```sh
node --test domain.test.mjs sync.test.mjs app-sync.test.mjs
python3 -B -m unittest discover -s . -p 'test_*.py' -v
```

Validação em 14/10/2026: 31 testes financeiros, 18 de combinação de versões, 3 de corridas/limpeza de sessão e 38 de armazenamento, autenticação e API aprovados. Testes HTTP executados com sockets locais; nenhum teste ignorado. As contas de teste usam bancos temporários e dados fictícios.

No navegador: login e persistência de sessão, atualização entre duas abas, preservação de formulário, combinação de nome/sobrenome alterados separadamente e conflito no mesmo campo com escolha explícita, saída propagada entre abas e recuperação indisponível sem SMTP. As verificações financeiras da etapa anterior cobrem parcelas, totais, recarga, edição individual e tags.

## Próxima etapa

Escolher hospedagem e configurar SMTP; conectar assinatura, indicações e recebimentos. Termos e privacidade devem ser redigidos para a nova aplicação. O aplicativo nativo e a paridade de todos os fluxos ainda precisam de implementação/validação.

No celular, esta versão oferece uma adaptação web utilizável. A referência original mostra um convite ao app; portanto essa adaptação é uma diferença deliberada e não uma reprodução do app nativo.
