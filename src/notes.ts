export function initialNotes(name: string, createdIso: string): string {
  return `# ${name}

Created: ${createdIso}

## Goal
(what this project is for - fill in)

## Done
- (nothing yet)

## Pending / Next steps
- (fill in)

## Decisions & constraints
- (fill in)

## Handoff log
- ${createdIso}: project created
`;
}
