# Estado do pacote — 18/10/2026

Este é um recorte do código existente para desenvolvimento colaborativo, com dados fictícios. O projeto original e os registros do proprietário foram preservados.

## Verificado nesta entrega

- 62 testes JavaScript passaram, sem falhas.
- 728 verificações PHP passaram, incluindo 5 novas verificações de inicialização do laboratório.
- Esquema SQLite e empacotador verificados.
- 47 verificações HTTPS no laboratório separado, com validação do certificado: login de duas contas fictícias, papéis distintos, publicação e resposta, denúncia, restrição do painel, remoção/restauração e persistência após novo login.
- Navegador em modo de interface: primeiro acesso, criar e editar tarefa, persistir após recarregar, iniciar/pausar/guardar relógio, navegar por curso e abrir página fictícia de apostila.
- Conta moderadora passou a ser preparada na inicialização, antes do primeiro login. A correção está restrita à composição do laboratório de desenvolvimento; não concede papéis por campos enviados pelo navegador.

## Conteúdo e limites

As fontes da interface, serviços, clientes, banco e testes foram selecionadas explicitamente. Dados de cursos, catálogo, páginas e capas foram substituídos por exemplos. Materiais comerciais, dados pessoais, credenciais, certificados, bancos, logs e histórico Git não pertencem ao ZIP. O arquivo MANIFEST.sha256 permite conferir os arquivos distribuídos.

Áudios e vídeos didáticos não estão incluídos. As funções de interface correspondentes continuam no código, mas não foi validada reprodução de áudio neste pacote. O repertório didático tem só uma progressão de exemplo. Os links privados de aulas foram removidos.

O teste HTTPS foi feito pela API; a jornada visual completa de login e moderação não foi repetida neste pacote. O navegador foi usado no modo de demonstração sem login. Não confundir essa verificação com aprovação de experiência por Luiz.

MySQL, e-mail real, recebimento real de webhooks, carga, implantação, retenção e revisão jurídica continuam pendentes. O ponto de entrada de produção permanece fechado com HTTP 503. Os termos existentes são minuta. Nenhum repositório, convite, hospedagem, serviço pago ou publicação foi criado.

## Continuidade para os devs

Leia README.md e o briefing antes de sugerir mudanças. Comece com uma tarefa pequena, revisão por outra pessoa e dados fictícios. A prioridade continua sendo simplificar o estudo pessoal. Sugestões são bem-vindas; alterações de produto e integrações externas dependem de decisão de Luiz.
