# Exact Excel mapping

The importer accepts the 28 headers from the supplied master workbook. It stores every original column under `rawData` and maps the business fields used by the app.

### Matching / update rule
1. `ID Number` is the preferred unique key.
2. If no ID Number exists, normalized `Contact 1` is used.
3. Duplicate rows in the same import are skipped.
4. Existing records are updated; unrelated members are never deleted by an import.
5. Manually entered `expiryDate`, `optIn`, and `callingConsent` are preserved during later Excel re-imports unless explicitly changed from the Admin Panel.
6. The ambiguous `EXP.` and `Renuwal Time` columns are preserved as supplied; the system does **not** guess an exact expiry date from them. The Owner can enter the exact `expiryDate` in the member editor.

### Export
Owner → Members → Export Excel recreates the 28-column workbook from the current database values.
