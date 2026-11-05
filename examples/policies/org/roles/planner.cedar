// Rola: planista. Dzieli zadanie na podzadania (PLAN.md 5.2). Tylko czyta kod,
// zapisuje wylacznie plan w docs/plans/. Bez push, bez merge, bez budowania.

@id("role.planner.exec-readonly")
@reason("Planista uzywa tylko komend przegladowych.")
permit (principal, action == Action::"exec", resource)
when {
  principal.role == "planner" &&
  (context.command == "git status" || context.command == "git log" ||
   context.command like "git log *" || context.command like "git diff*" ||
   context.program == "rg" || context.program == "ls")
};

@id("role.planner.write-plans")
@reason("Planista zapisuje plany tylko w docs/plans/.")
permit (principal, action == Action::"fs_write", resource)
when { principal.role == "planner" && context.path like "docs/plans/*" };

@id("role.planner.models")
@reason("Planista moze uzywac duzego modelu rozumujacego.")
permit (principal, action == Action::"llm_call", resource)
when { principal.role == "planner" && ["corp-reasoner-large"].contains(context.model) };

@id("role.planner.mcp")
@reason("Planista korzysta z wyszukiwania w kodzie, dokumentacji i odczytu Jira.")
permit (principal, action == Action::"mcp_call", resource)
when {
  principal.role == "planner" &&
  ["code-search.query", "internal-docs.search", "jira.read"].contains(context.tool)
};
