// Warstwa ORG, profil "firmowy" (PLAN.md 4.3): LLM Gateway w sieci firmowej,
// wewnetrzny forge, mirrory pakietow. Dystrybuowana przez MDM/GPO, podpisana.
// Domyslnie wszystko jest zabronione (Cedar: brak pasujacego permit = deny).
// Role dodaja swoje uprawnienia w org/roles/*.cedar.
//
// Adnotacje:
//   @id("...")         stabilny identyfikator reguly, trafia do audit logu
//   @reason("...")     uzasadnienie zapisywane w decyzji
//   @approval("human") akcja jest dozwolona, ale wymaga zgody czlowieka

// ---------- Zakazy twarde (forbid zawsze wygrywa z permit) ----------

@id("org.forbid.secret-files")
@reason("Agent nie czyta plikow z sekretami ani kluczy prywatnych.")
forbid (principal, action == Action::"fs_read", resource)
when {
  context.path like ".env*" || context.path like "*/.env*" ||
  context.path like "secrets/*" || context.path like "*/secrets/*" ||
  context.path like "*.pem" || context.path like "*.key"
};

@id("org.forbid.git-internals")
@reason("Zapis do .git (hooki, konfiguracja) pozwalalby obejsc wrapper git.")
forbid (principal, action == Action::"fs_write", resource)
when { context.path like ".git/*" || context.path like "*/.git/*" };

@id("org.forbid.net-tools")
@reason("Narzedzia sieciowe omijaja Egress Guard; siec tylko przez proxy.")
forbid (principal, action == Action::"exec", resource)
when { ["curl", "wget", "ssh", "scp", "nc", "ncat", "socat"].contains(context.program) };

@id("org.forbid.force-push")
@reason("Force push jest zabroniony dla agentow bez wyjatkow.")
forbid (principal, action == Action::"git_push", resource)
when { context.force };

@id("org.forbid.non-onprem-models")
@reason("Profil firmowy dopuszcza wylacznie modele on-prem za LLM Gateway.")
forbid (principal, action == Action::"llm_call", resource)
unless { context.model_location == "onprem" };

@id("org.forbid.unsigned-mcp")
@reason("Serwery MCP tylko z wewnetrznego, podpisanego katalogu.")
forbid (principal, action == Action::"mcp_call", resource)
unless { context.catalog == "internal-signed" };

@id("org.forbid.restricted-data-merge")
@reason("Repozytoria scisle tajne (klasa 3): agent nigdy nie scala.")
forbid (principal, action == Action::"git_merge", resource)
when { resource.data_class >= 3 };

// ---------- Uprawnienia bazowe dla wszystkich rol ----------

@id("org.allow.read-worktree")
@reason("Odczyt worktree (z wylaczeniem plikow zakazanych powyzej).")
permit (principal, action == Action::"fs_read", resource);

@id("org.allow.net-corporate")
@reason("Jedyne dozwolone hosty: LLM Gateway, forge i mirrory pakietow.")
permit (principal, action == Action::"net_connect", resource)
when {
  context.port == 443 &&
  [
    "llm-gateway.corp.example",
    "git.corp.example",
    "npm.mirror.corp.example",
    "pypi.mirror.corp.example",
    "crates.mirror.corp.example"
  ].contains(context.host)
};
