// Rola: recenzent. Tylko czyta; nie zapisuje plikow. Moze komentowac w forge
// przez MCP oraz zaproponowac merge, ktory zawsze wymaga zgody czlowieka.

@id("role.reviewer.exec-readonly")
@reason("Recenzent uzywa tylko komend przegladowych.")
permit (principal, action == Action::"exec", resource)
when {
  principal.role == "reviewer" &&
  (context.command == "git status" || context.command like "git diff*" ||
   context.command like "git log*" || context.command like "git show *" ||
   context.program == "rg" || context.program == "ls")
};

@id("role.reviewer.models")
@reason("Recenzent uzywa duzego modelu rozumujacego.")
permit (principal, action == Action::"llm_call", resource)
when { principal.role == "reviewer" && ["corp-reasoner-large"].contains(context.model) };

@id("role.reviewer.mcp")
@reason("Recenzent czyta kod i dokumentacje oraz dodaje komentarze w forge.")
permit (principal, action == Action::"mcp_call", resource)
when {
  principal.role == "reviewer" &&
  ["code-search.query", "internal-docs.search", "forge.review_comment"].contains(context.tool)
};

@id("role.reviewer.merge-approval")
@reason("Merge zawsze za zgoda czlowieka; tylko z galezi agent/* do galezi roboczej.")
@approval("human")
permit (principal, action == Action::"git_merge", resource)
when {
  principal.role == "reviewer" &&
  context.source_branch like "agent/*" && context.target_branch like "feature/*"
};
