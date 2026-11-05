// Rola: implementer. Jedyna rola z prawem zapisu do kodu i push (za zgoda).
// Zmiany w CI, zaleznosciach i plikach wrazliwych: zawsze zgoda czlowieka
// (PLAN.md 4.1 pkt 4).

@id("role.implementer.exec-build")
@reason("Implementer buduje, formatuje i commituje w swoim worktree.")
permit (principal, action == Action::"exec", resource)
when {
  principal.role == "implementer" &&
  (context.command == "cargo build" || context.command like "cargo build *" ||
   context.command == "cargo check" || context.command like "cargo check *" ||
   context.command == "cargo fmt" || context.command like "cargo fmt *" ||
   context.command == "cargo clippy" || context.command like "cargo clippy *" ||
   context.command == "cargo test" || context.command like "cargo test *" ||
   context.command == "git status" || context.command like "git diff*" ||
   context.command like "git add *" || context.command like "git commit *" ||
   context.program == "rg" || context.program == "ls")
};

@id("role.implementer.exec-deps-approval")
@reason("Instalacja zaleznosci zmienia lancuch dostaw; zgoda czlowieka.")
@approval("human")
permit (principal, action == Action::"exec", resource)
when {
  principal.role == "implementer" &&
  (context.command like "cargo add *" || context.command like "cargo update*" ||
   context.command like "npm install *" || context.command like "pip install *")
};

@id("role.implementer.write-code")
@reason("Implementer zapisuje kod, testy i dokumentacje.")
permit (principal, action == Action::"fs_write", resource)
when {
  principal.role == "implementer" &&
  (context.path like "src/*" || context.path like "*/src/*" ||
   context.path like "tests/*" || context.path like "docs/*")
};

@id("role.implementer.write-ci-approval")
@reason("Zmiany w CI wymagaja zgody czlowieka.")
@approval("human")
permit (principal, action == Action::"fs_write", resource)
when {
  principal.role == "implementer" &&
  (context.path like ".github/*" || context.path == ".gitlab-ci.yml" ||
   context.path like "ci/*")
};

@id("role.implementer.write-deps-approval")
@reason("Zmiany w zaleznosciach wymagaja zgody czlowieka.")
@approval("human")
permit (principal, action == Action::"fs_write", resource)
when {
  principal.role == "implementer" &&
  (context.path == "Cargo.toml" || context.path == "Cargo.lock" ||
   context.path like "*/Cargo.toml" || context.path == "package.json" ||
   context.path == "package-lock.json" || context.path == "pyproject.toml" ||
   context.path == "requirements.txt")
};

@id("role.implementer.write-sensitive-approval")
@reason("Pliki wrazliwe (infra/) wymagaja zgody czlowieka.")
@approval("human")
permit (principal, action == Action::"fs_write", resource)
when { principal.role == "implementer" && context.path like "infra/*" };

@id("role.implementer.push-approval")
@reason("Push tylko na galezie agent/*, zawsze za zgoda czlowieka.")
@approval("human")
permit (principal, action == Action::"git_push", resource)
when {
  principal.role == "implementer" &&
  context.remote == "origin" && context.branch like "agent/*"
};

@id("role.implementer.models")
@reason("Implementer uzywa modeli kodujacych.")
permit (principal, action == Action::"llm_call", resource)
when {
  principal.role == "implementer" &&
  ["corp-coder-large", "corp-coder-small"].contains(context.model)
};

@id("role.implementer.mcp")
@reason("Implementer korzysta z wyszukiwania w kodzie, dokumentacji i odczytu Jira.")
permit (principal, action == Action::"mcp_call", resource)
when {
  principal.role == "implementer" &&
  ["code-search.query", "internal-docs.search", "jira.read"].contains(context.tool)
};
