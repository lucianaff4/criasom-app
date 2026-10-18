# Criasom

Organizador pessoal de estudo musical. **Meu estudo** é a tela principal: escrever tarefas diretamente, editar, marcar e reorganizar. Datas, categorias e duração são opcionais. Repertório pessoal e cronograma livre vêm antes dos cursos, que apoiam as aulas e a musicalidade.

Este pacote reúne o código existente em 18 de outubro de 2026, selecionado para desenvolvimento colaborativo. A interface, modelo de estudo, conta, progresso, fórum, imagens e moderação estão incluídos. **Os dados são fictícios. Não é uma implantação pronta para alunos reais.**

Leia [a visão do produto](docs/criasom-visao-e-colaboracao-devs.pdf), [como contribuir](CONTRIBUTING.md) e [os limites de segurança](SECURITY.md).

## Colocar no GitHub

Crie um repositório **privado** sob controle de Luiz. Extraia este ZIP e envie o conteúdo da pasta, incluindo `.gitignore`, `.gitattributes` e `.github`. Subir apenas o ZIP não disponibiliza os arquivos para revisão de código. Não acrescente arquivos da pasta original, bancos, materiais de cursos ou estado criado durante os testes.

Não há histórico Git neste pacote, nem integração com hospedagem ou cobrança. Não foi escolhida uma licença de código aberto: combine as condições de contribuição e uso antes de ampliar o acesso ou tornar o repositório público. O campo `private` de package.json impede publicação npm acidental; não configura a visibilidade no GitHub.

## Abrir a interface rapidamente

Requisito: Node.js 20 ou superior. Não há dependências npm para instalar.

```sh
npm run demo
```

Abra `http://127.0.0.1:8080/`. Este modo testa tarefas, repertório, navegação e ferramentas no navegador. O fórum é uma demonstração local sem duas contas. O repertório didático tem apenas uma progressão fictícia; a lógica de busca, acordes e capotraste foi preservada.

## Testar login e fórum com duas contas

Requisitos adicionais: PHP 8.3+ com PDO SQLite, OpenSSL e GD; Python 3.10+ com a biblioteca de certificado indicada em `requirements-dev.txt`. Use um ambiente virtual Python. Não instale nem compartilhe credenciais de produção.

```sh
python -m venv .venv
```

Ative com `.venv\Scripts\Activate.ps1` no PowerShell ou `source .venv/bin/activate` no macOS/Linux. Depois:

```sh
python -m pip install -r requirements-dev.txt
npm run dev
```

O iniciador procura `php` e `python` (Windows) ou `python3` (macOS/Linux) no PATH. Se necessário, defina `CRIASOM_PHP` e `CRIASOM_PYTHON` com os caminhos dos executáveis. Um PHP portátil Windows pode usar `CRIASOM_PHP_EXT_DIR`; as DLLs devem corresponder à instalação PHP. Não há caminhos do computador original no iniciador.

Abra `https://127.0.0.1:8543/app/`. O certificado é gerado para este laboratório e o navegador pode mostrar um aviso. Confira o endereço local antes de decidir prosseguir; o iniciador não instala certificados no sistema nem desativa a validação global.

- `penta@example.test`: conta fictícia com função de moderador e acesso à Penta.
- `harmonia@example.test`: conta fictícia de aluno com acesso à Harmonia.

Clique em **Receber código**, **Ver código de teste** e **Entrar**. Nenhum e-mail é enviado. Use uma janela normal e uma janela anônima, ou dois perfis de navegador, para manter as sessões separadas. As duas contas de desenvolvimento não são acessos de produção.

Na conta de aluno, abra Comunidade, leia e aceite os termos fictícios para o teste, publique e adicione uma imagem se quiser. Entre com a conta moderadora para responder, analisar uma denúncia e remover/restaurar a publicação. Teste também bloqueio e desbloqueio da comunidade. O bloqueio não deve retirar o estudo nem o acesso ao curso.

Os dados e segredos de teste são criados em `.local/`, ignorada pelo Git. Não compartilhe essa pasta, mesmo sendo local. Feche o processo com Ctrl+C. Os registros permanecem para o próximo uso; uma reinicialização não deve apagá-los. As portas padrão 8543 e 8865 evitam interferir no laboratório original.

## Verificações

```sh
npm test
npm run check:package
```

O teste usa dados sintéticos e cobre modelo, cliente, conta, permissões, progresso, eventos de compra, fórum, moderação e imagens. Não envia e-mails, webhooks externos ou mensagens. `check:package` procura artefatos privados e padrões suspeitos nos arquivos destinados ao repositório; não é certificação de ausência de vulnerabilidades.

`npm run build:demo` gera o HTML isolado em `outputs/`. Edite as fontes, nunca apenas esse HTML. O arquivo gerado não substitui o servidor com login e não inclui o catálogo didático separado; para navegar por ele, use `npm run demo`.

## Estrutura

- `work/criasom-app-piloto/dist/`: interface, modelo e amostras fictícias.
- `work/criasom-app-piloto/dist/repertorio/`: código do repertório didático e catálogo fictício.
- `work/production-base/src/`: serviços PHP existentes.
- `work/production-base/client/`: conexão da interface com conta, progresso e fórum.
- `work/production-base/sql/`: esquemas SQLite e MySQL. MySQL ainda não validado.
- `work/production-base/dev/`: laboratório exclusivo de loopback; não hospedar publicamente.
- `work/production-base/tests/`: verificações automatizadas e fixtures.
- `docs/`: briefing e estado desta entrega.

## O que ficou fora

Apostilas, áudios, vídeos, catálogo comercial, links privados de aulas, dados de alunos/compradores, compras reais, bancos, backups, logs, certificados, chaves, relatórios internos, executáveis e histórico Git. Não foram apagados do projeto original. Imagens de páginas e dados dos cursos foram substituídos por amostras explícitas, preservando IDs técnicos necessários à compatibilidade dos testes.

## Antes de produção

`public/index.php` continua respondendo 503. Não remova essa trava para simplesmente subir a pasta na hospedagem. Faltam integração real de e-mail e Hotmart, conciliação de alunos, validação MySQL/carga/backup, armazenamento e retenção, revisão jurídica e operacional e avaliação da experiência com usuários. A caixa de códigos fictícios e as compras de exemplo nunca devem ser expostas na internet.

O personalizador atual usa regras; chatbot e integração de áudio são possibilidades futuras. Nenhum serviço externo ou cobrança foi ativado para gerar este pacote.
