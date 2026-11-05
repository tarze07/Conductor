// Warstwa PROJEKT: repozytorium "payments-service" (klasa danych 2, poufne).
// Plik zyje w repo (.conductor/policy/) i jest podpisany kluczem wlascicieli
// projektu. Warstwa moze WYLACZNIE zaostrzac: zawiera forbid oraz permit z
// @approval (dodatkowa zgoda czlowieka). Zwykle permit w tej warstwie nie
// poszerza uprawnien: org musi je tez dac. conductord dopisuje do kazdej
// warstwy nizszej niejawny permit-all (patrz README), wiec brak permit nie
// blokuje akcji, ktore org dopuszcza.

@id("project.payments.forbid-non-agent-push")
@reason("Push z tego repo tylko na galezie agent/*.")
forbid (principal, action == Action::"git_push", resource)
unless { context.branch like "agent/*" };

@id("project.payments.forbid-agent-merge")
@reason("W projekcie platniczym agenci nie scalaja; robi to czlowiek w forge.")
forbid (principal, action == Action::"git_merge", resource);

@id("project.payments.models")
@reason("Dane poufne: tylko najwiekszy model kodujacy, hostowany on-prem.")
forbid (principal, action == Action::"llm_call", resource)
unless { context.model == "corp-coder-large" || context.model == "corp-reasoner-large" };

@id("project.payments.forbid-migrations")
@reason("Migracje bazy danych pisze wylacznie czlowiek.")
forbid (principal, action == Action::"fs_write", resource)
when { context.path like "migrations/*" };

@id("project.payments.forbid-jira-write")
@reason("Agenci nie modyfikuja ticketow w projekcie platniczym.")
forbid (principal, action == Action::"mcp_call", resource)
when { context.tool like "jira.write*" || context.tool like "jira.transition*" };

@id("project.payments.forbid-publish")
@reason("Publikacja artefaktow tylko z pipeline'u CI.")
forbid (principal, action == Action::"exec", resource)
when { context.command like "cargo publish*" || context.command like "docker push*" };

// Zaostrzenie przez dodatkowa zgode: zapis do kodu platnosci jest dozwolony
// przez org tylko jako zwykly zapis w src/, tu dodajemy wymog zgody czlowieka.
@id("project.payments.approve-payments-code")
@reason("Zmiany w src/payments/ wymagaja zgody czlowieka.")
@approval("human")
permit (principal, action == Action::"fs_write", resource)
when { context.path like "src/payments/*" };
