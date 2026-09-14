# Ledger in wrong group (trial balance check 8) — design

### 1. Scope and requirement mapping

| Requirement | Where |
|---|---|
| Report ledgers that are probably in the wrong group, such as an expense ledger under Capital Account | `src/checks/ledgerInWrongGroup.ts` |
| Deterministic and computed in code; the model never judges a name | `src/checks/nameSignal.ts` |
| Never leak a masked name, not even one word of it | §7; `test/leak.test.ts` secrets `orchid medical expenses`, `orchid`, `medical` |
| Operator tuning without code changes | `wrongGroup` key of `config/overrides.json`, read by `loadWrongGroup` (§8) |
| Excluded: changes to the seven milestone 1 checks, masking policy, Excel, write path, new tools | unchanged files; registry stays at nine tools |

### 2. Identity

- Check id `ledger_in_wrong_group`, ordinal 8, finding ids `TB-008-<n>`. `n` counts this check's findings in trial balance row order.
- Severity is always `warning`. The check fires only when a ledger's name and its group contradict each other across the two statements, which misstates profit or net worth. It is still a reading of words, so it is not `critical`.
- The check runs last in `ALL_CHECKS`. The ids of checks 1–7 and the order in which pseudonyms are minted stay as they were.

### 3. Reading a name (`src/checks/nameSignal.ts`)

- Tokens: `canonicalKey(name)` split on anything that is not `a-z` or `0-9`. A token matches only as a whole word, never as a substring, so `rent` never matches `current`.
- The word lists are `expense`, `income`, `party`, `bank`, `capital` and `loan`, plus a `neutral` list. They are disjoint, and a test holds them to it.
- A neutral token vetoes the name: `Salary Payable`, `Prepaid Rent`, `Bank Charges`, `Capital Gains` and `TDS on Salary` say nothing.
- Contradictory words also mean no signal:
  - expense and income together (`Sales Expenses`);
  - either of those with a balance sheet word (`Rent - Nimbus Enterprises`, `Capital Goods Purchase`).
- When several balance sheet words appear, the more specific one wins: loan, then bank, then capital, then party. So `Zeta Bank Car Loan` is a loan and `Zeta Bank Ltd` is a bank.
- Operator words (§8) are added after the built-in words and win any clash.
- A name with no Latin letters or digits yields no tokens, so it never fires.

### 4. Reading a group

- The root is the first predefined primary group in `Classifier.ancestry(parent)`.
- Nature of each root:

  | Root | Nature |
  |---|---|
  | Capital Account | capital |
  | Loans (Liability), Current Liabilities | liability |
  | Fixed Assets, Investments, Current Assets, Misc. Expenses (ASSET) | asset |
  | Sales Accounts, Direct Incomes, Indirect Incomes | income |
  | Purchase Accounts, Direct Expenses, Indirect Expenses | expense |

- No finding when the root is Suspense A/c or Branch / Divisions (they say nothing about a ledger's nature), or when the ancestry reaches no primary group.

### 5. The rule

No finding for a zero balance or for a ledger in `wrongGroup.ignoreLedgers`. Otherwise:

1. **A balance sheet name** (party, bank, capital, loan) **under an income or expense root** fires on any balance.
2. **An expense or income name under a balance sheet root** fires only when both of these hold:
   - the balance sits on the name's natural side (expense Dr, income Cr);
   - that side is not the one the root normally carries (asset Dr, liability Cr; Capital Account has no normal side here).

   So:
   - `Rent` Dr under Current Assets reads as prepaid rent and stays silent.
   - `Salary` Cr under Sundry Creditors reads as salary payable and stays silent.
   - `Salary` Dr under Sundry Creditors fires.
   - `Medical Expenses` Dr under Capital Account fires.

   A group between the ledger and its root whose name has the word `drawing`, `drawings` or `personal` exempts the ledger. Personal spending belongs there.
3. **Income under an expense root, or the reverse,** is presentation only and is not reported.

### 6. Finding contract

- `ledger` is the trial balance row name, masked by the unchanged policy. `group` is the immediate parent and is never masked. `amount` is the absolute balance; `side` is `Dr` or `Cr`.
- `expected` is the nature of the group the ledger probably belongs under. Checks 1–7 keep a side there.

| Name reads as | Balance | Suggested place | `expected` |
|---|---|---|---|
| expense | either | Direct Expenses, Indirect Expenses or Purchase Accounts | `expense` |
| income | either | Sales Accounts, Direct Incomes or Indirect Incomes | `income` |
| party | Dr / Cr | Sundry Debtors / Sundry Creditors | `asset` / `liability` |
| bank | Dr / Cr | Bank Accounts / Bank OD A/c | `asset` / `liability` |
| capital | either | Capital Account | `capital` |
| loan | Dr / Cr | Loans & Advances (Asset) / Loans (Liability) | `asset` / `liability` |

Detail template (money through `money()`, dates through `displayDate()`):

```
<ledger> reads as <phrase> but is grouped under <root>, with a <side> balance of <amount> as of <date>;
as placed, <consequence>. Move it under <suggested place>[<drawings hint>].
If the placement is deliberate, list it in wrongGroup.ignoreLedgers in config/overrides.json
```

- `<phrase>` is one of these fixed phrases: `an expense ledger`, `an income ledger`, `a party (debtor or creditor) ledger`, `a bank ledger`, `a capital or drawings ledger`, `a loan ledger`.
- `<consequence>` depends on the root:
  - an income or expense root gives `its balance runs through the profit and loss account`;
  - any other root gives `it is kept out of the profit and loss account`.
- `<drawings hint>` appears only for an expense name under Capital Account: `, or under a Drawings sub-group of Capital Account if it is an owner's personal spending`.

### 7. Masking

- Reading names happens only inside the check. It never changes what is masked; the masking policy of the milestone 1 design (§4) is unchanged.
- The detail holds the ledger's whole name once, and otherwise only fixed text. The phrase is generic and never quotes a matched word. `maskFinding` swaps the whole name for its pseudonym, so no fragment of a masked name survives.
- A party-looking name under a clear group (for example a purchase sub-group) is reported in the clear. That ledger is already clear everywhere else (milestone 1 design §4.4). The operator's remedy is `forceMaskLedgers`, which turns the finding's ledger into `Ledger N`.
- Accepted edge: a masked ledger already in the vault may be named exactly like fixed detail text, such as `Capital Account` or `Drawings`. The model's copy of the detail then shows that ledger's alias in the fixed text. Nothing leaks, and the written report restores the text.

### 8. Operator tuning

```json
"wrongGroup": {
  "ignoreLedgers": [],
  "keywords": { "expense": [], "income": [], "party": [], "bank": [], "capital": [], "loan": [], "neutral": [] }
}
```

- `ignoreLedgers` holds ledgers confirmed as correctly placed, matched ignoring case and whitespace.
- `keywords` holds single words of letters and digits. The loader canonicalises them.
  - An unknown list name or a multi-word entry throws at start-up, and the error never echoes the entry.
  - An operator signal word removes a built-in neutral word, and an operator neutral word removes a built-in signal word.
- A missing file means no tuning; `loadOverrides` has already warned about it. Malformed JSON throws.
- `loadWrongGroup` is a separate loader, so `loadOverrides` and its fail-open warning are unchanged.

### 9. Known limits (accepted false negatives)

- An expense name with a debit balance under an asset group: capitalised repairs, prepaid expenses, deposits.
- An income name with a credit balance under a liability group: advances received.
- Income under an expense group, or the reverse.
- Person names, abbreviations outside the word lists, and names in scripts other than Latin.
- A ledger may raise both this check and `wrong_side_balance`. For example, `Wages` Dr under Sundry Creditors asks two different questions.

### 10. Testing

- `test/name-signal.test.ts` and `test/checks-wrong-group.test.ts` are table-driven, with near-misses for every rule.
- `test/overrides.test.ts` covers the loader.
- Fixture rows:
  - `orchid medical expenses` under Capital Account fires.
  - `household medical expenses` under a Drawings sub-group stays silent.
  - `nimbus enterprises` under a purchase sub-group fires in the clear.
- `test/review.test.ts`, `test/server-tools.test.ts` and `test/report.test.ts` cover the session, the tools and the CSV.
- `test/leak.test.ts` holds the name and two of its words as secrets. It also asserts that the finding carrying them really fires, and only as `Capital N`.
