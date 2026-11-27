---
'@adonis-agora/flags': patch
---

`track(..., { client })` accepts a real Lucid transaction, connection or `db` again: `SqlClient.rawQuery` took `readonly unknown[]` bindings, which Lucid's mutable `RawQueryBindings` parameter rejected under strict typechecking.
