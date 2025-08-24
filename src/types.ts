export type StandupAnswer = {
  yesterday?: string;
  today?: string;
  blockers?: string;
  other?: string;
  submittedAt?: string;
  displayName?: string;   // ← store the name we saw when recording
};

export type StandupState = {
  date: string;   // yyyy-mm-dd
  status: "idle" | "collecting" | "frozen";
  members: string[];
  responses: Map<string, StandupAnswer>; // key=userId
};
