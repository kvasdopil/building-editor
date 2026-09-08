# Parent height validation insights

- Parent lookup deliberately returns an unresolved part as its own building for selection. Upload validation must distinguish that fallback from an actual parent, or a part's own height can incorrectly satisfy the parent requirement.
- Effective render heights include a guessed storey when no height is tagged. Parent-height validation must inspect explicit normalized height/levels instead of the rendered extent.

Processed into the parent-height upload requirement in [the submission spec](memory/spec/domain/osm-submission.md), which owns the rule and its validation scope.
