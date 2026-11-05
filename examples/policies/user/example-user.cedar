// Warstwa UZYTKOWNIK: osobiste ustawienia dewelopera (~/.config/conductor/policy/).
// Nie wymaga podpisu, bo moze tylko zaostrzac (forbid i @approval). Proba
// poszerzenia uprawnien nie ma efektu: org i projekt nadal musza zezwolic.

@id("user.forbid-mcp-jira")
@reason("Nie chce, zeby agenci dotykali Jiry w moich przebiegach.")
forbid (principal, action == Action::"mcp_call", resource)
when { context.tool like "jira.*" };

@id("user.approve-every-commit")
@reason("Chce zatwierdzac kazdy commit agenta recznie.")
@approval("human")
permit (principal, action == Action::"exec", resource)
when { context.command like "git commit *" };
