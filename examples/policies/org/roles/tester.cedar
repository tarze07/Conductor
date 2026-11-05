// Rola: tester. Uruchamia testy i pisze wylacznie w tests/. Bez push i merge,
// bez zmian w kodzie produkcyjnym, CI i zaleznosciach.

@id("role.tester.exec-tests")
@reason("Tester uruchamia testy i przeglada zmiany.")
permit (principal, action == Action::"exec", resource)
when {
  principal.role == "tester" &&
  (context.command == "cargo test" || context.command like "cargo test *" ||
   context.command == "cargo nextest run" || context.command like "cargo nextest run *" ||
   context.command like "pytest*" ||
   context.command == "git status" || context.command like "git diff*" ||
   context.program == "rg" || context.program == "ls")
};

@id("role.tester.write-tests")
@reason("Tester zapisuje tylko w katalogach testow.")
permit (principal, action == Action::"fs_write", resource)
when { principal.role == "tester" && (context.path like "tests/*" || context.path like "*/tests/*") };

@id("role.tester.models")
@reason("Tester uzywa mniejszego modelu kodujacego.")
permit (principal, action == Action::"llm_call", resource)
when { principal.role == "tester" && ["corp-coder-small"].contains(context.model) };

@id("role.tester.mcp")
@reason("Tester korzysta tylko z wyszukiwania w kodzie.")
permit (principal, action == Action::"mcp_call", resource)
when { principal.role == "tester" && context.tool == "code-search.query" };
