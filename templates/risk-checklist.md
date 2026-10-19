# Risk checklist

Each gap is a finding.

- Transactions: writes that belong together all happen or none do; a failure halfway rolls back.
- Repeats: a retried request, job or message does its work once.
- External calls: timeouts, errors and partial results are handled; nothing is sent twice.
- Values: tests use realistic values (fractions, rounding, large and boundary amounts).
