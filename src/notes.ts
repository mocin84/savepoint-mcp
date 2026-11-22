export function initialNotes(name: string, createdIso: string, task = ""): string {
  // The task is stored at creation so a new chat can start the work even if
  // the first chat hit its limit before saving any file.
  const goal = task || "(what this project is for - fill in)";
  const pending = task ? "- Start the task in Goal (nothing saved yet)" : "- (fill in)";
  return `# ${name}

Created: ${createdIso}

## Goal
${goal}

## Done
- (nothing yet)

## Pending / Next steps
${pending}

## Decisions & constraints
- (fill in)

## Handoff log
- ${createdIso}: project created
`;
}
