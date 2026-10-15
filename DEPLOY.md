# Preparação de hospedagem

A hospedagem ainda não foi escolhida nem publicada. Login e sincronização já funcionam contra uma instância do servidor. Todos os dispositivos deverão abrir o mesmo domínio HTTPS e entrar na mesma conta. Não há conexão com a base ou as contas do App do Breno original.

## Ambiente necessário

- Linux com Python 3.11+ que ofereça `hashlib.scrypt`, SQLite e disco persistente.
- Uma única instância do aplicativo atrás de proxy HTTPS. Não usar hospedagem apenas de arquivos estáticos, disco efêmero ou réplicas com bancos separados.
- Reservar memória para até dois hashes scrypt simultâneos, além do aplicativo; dimensionar por medição antes de abrir a público amplo. O servidor atual é uma implementação pessoal/pequena, sem teste de carga em produção.
- Domínio e certificado válidos; e-mail SMTP com TLS para recuperação.

Não existem dependências Python externas. Confirme o suporte com:

```sh
python3 -c 'import hashlib; assert hasattr(hashlib, "scrypt")'
```

## Antes da migração

Crie sua primeira conta **no ambiente local**. Para continuar o planejamento anterior, marque a opção de importar os dados locais durante esse primeiro cadastro. O original permanece na tabela de legado, mas só o primeiro cadastro local pode reivindicar essa cópia. Cadastros seguintes começam vazios. Em modo público, a importação de legado fica desativada.

Pare o servidor local e faça uma cópia de `data/app.sqlite`. Transfira o banco completo (contas, sessões, planejamentos e legado) para o disco persistente escolhido usando canal privado. Não coloque o banco, backups ou variáveis de ambiente em pastas públicas. Para uma instalação nova, use um caminho de banco vazio: as contas começam sem movimentações.

## Inicialização e HTTPS

Copie o código para `/opt/meu-financeiro` e o banco para `/var/lib/meu-financeiro/app.sqlite`. Crie um usuário de serviço `financeiro`, proprietário apenas da pasta de dados; o código precisa ser legível por ele. Ajuste domínio, caminhos e Python no modelo `deploy/financeiro.service.example` antes de instalar como serviço.

Comando equivalente:

```sh
python3 -B server.py --port 4173 --db /var/lib/meu-financeiro/app.sqlite --public-origin https://financeiro.example.com
```

O aplicativo permanece restrito a `127.0.0.1`. O proxy termina HTTPS, preserva o cabeçalho Host do domínio e encaminha para a porta 4173. `deploy/Caddyfile.example` contém um modelo. Não exponha a porta 4173. DNS, certificado, instalação do proxy e do serviço dependem da hospedagem escolhida e ainda não foram executados.

`--public-origin` exige HTTPS e ativa cookies Secure; chamadas com outro Host/Origin são recusadas. O controle por endereço vê o proxy local; limites por conta também existem. Antes de ampliar uso, configurar limites por IP real na borda e avaliar capacidade. Não confiar em cabeçalhos X-Forwarded enviados pelo cliente.

## Recuperação por e-mail

Preencha as variáveis de `deploy/smtp.env.example` pelo gerenciador de segredos do provedor, ou em `/etc/meu-financeiro.env` com permissão 0600, lido pelo serviço. O arquivo `.env` não é carregado automaticamente ao iniciar manualmente: as variáveis devem estar no ambiente do processo.

TLS aceita `starttls` (normalmente porta 587) ou `ssl` (normalmente 465), conforme o fornecedor. Configure remetente autorizado e as regras de entrega do seu domínio. Reinicie o processo após configurar. O link de recuperação dura30 minutos, é de uso único e invalida sessões anteriores. Sem configuração, a interface informa indisponibilidade e não simula envio. Nenhum e-mail foi enviado nesta implementação.

## Backup e validação de publicação

Com o serviço parado, copie o banco completo para armazenamento privado e retome o serviço. Para backup sem parada, use a API de backup do SQLite; não copie somente o arquivo principal durante gravações. Proteja e teste a restauração dos backups. O arquivo contém dados pessoais e hashes: não é criptografado pelo aplicativo.

Depois de hospedar, verificar com contas próprias de teste: cadastro, login, acesso negado sem sessão, isolamento entre duas contas, gravação/recarga, atualização entre dois dispositivos, conflito de edição, saída e recuperação por e-mail real. Validar backup restaurado antes de uso contínuo. As verificações locais estão em `README.md`; não substituem essa validação no domínio final.

## Limites conhecidos

A sincronização consulta mudanças a cada 5segundos e ao voltar à aba. Ações independentes são combinadas e conflitos pedem escolha. Sem conexão, o formulário permanece aberto para tentar salvar novamente; não há fila offline persistente, e recarregar/fechar descarta rascunhos. A confirmação “sincronizado” significa que o servidor confirmou a versão, não que existe backup externo.

Ainda não há verificação de propriedade do e-mail no cadastro, autenticação multifator, gestão administrativa, integração de assinatura ou app nativo. Definir esses requisitos e termos/privacidade próprios antes de lançar um serviço comercial.
