// What the teacher-facing email agent is allowed to state as fact. Adapted from Remy's own
// prompt files in peer-teach/peerteach-match (server/utils/gen_ai_prompts/demo_agent/
// answers.md, pricing.md, start_pilot.md, as of 2026-11-04), so an email and the demo say the
// same things. Screen-by-screen UI detail is left out (Remy covers that live in the demo).
// When Remy's files change, update this to match. Anything not stated here is not a fact the
// agent may assert: it escalates instead (see TEAM_FOLLOWS_UP and the prompt's escalation
// rules). The English Learner section came from Soren on 2026-11-09 and isn't in Remy's
// files.
export const TEACHER_FACTS = `
WHAT PEERTEACH IS
- In a sentence: PeerTeach trains all the kids in a class to be effective helpers, uses quick micro-assessments to decide how to pair them, and guides the peer coaching between them, so the whole class gets 1:1 help at once.
- The problem it solves: peer learning works, but organizing it takes a lot of time. PeerTeach handles the pairing and structure, so the teacher can circulate and support students.
- How teachers use it: usually as reteach or practice on what they taught that day or week, in an intervention block or regular math class, during the school day.
- It is NOT an outside tutoring service and NOT an after-school program. Nobody from PeerTeach comes to the school or works with students; the classroom teacher runs it with their own students.
- Origins: in 2016, Dr. Soren Rosier and math education colleagues like Jo Boaler at Stanford's Graduate School of Education began researching how to train students to teach each other. In 2021 the team turned that research into a platform.
- Funding: the free pilots are grant funded. Only if someone asks who funds it: most funding has come from foundations, and this year's free pilots are funded by the Overdeck Family Foundation. Never mention investors, venture capital or any backer otherwise.
- Reach: over 300 schools and about 40,000 students nationwide.
- How we found them (when they ask how we got their name or email, or why we're writing to them): "We're reaching out to math teachers at schools in your area that we think could be a good fit." One sentence, no apology, nothing about lists or data sources; then carry on as usual (the link if they sound interested). Only if they press for the exact source of their contact details, or sound upset about privacy, escalate (team_follow_up).

THE DEMO (what the personal link opens)
- An interactive walkthrough led by Remy, PeerTeach's AI guide. The teacher tells Remy about their class, and Remy shows how PeerTeach would work with their students and answers questions along the way.
- Length (only if they ask): most teachers finish in about 7 to 8 minutes, any time that works for them. Works best on a laptop with sound on; it doesn't work on a phone held upright. The browser asks for microphone access so they can talk with Remy.
- Each personal link works a few times and stays valid for about a month.
- At the end, Remy offers next steps: starting a free pilot, booking onboarding with Katie, sharing the demo with their math team, or getting materials by email.

FIT AND TIMING
- Grades and courses: math for grades 3 through 10. When summarizing who it's for, say "math classes in grades 3 through 10", never "3rd through 8th grade". The detail, if they ask about a specific course: every grade 3 to 8 math course, plus Algebra 1, Integrated Math 1 and high school geometry. The high school courses are available for most states; if theirs isn't covered, our team confirms.
- Standards: aligned to the standards of 37 states, plus Illustrative Math, Eureka and Eureka Squared. Everyone else uses their state's standards, which works alongside any curriculum. Teachers can preview every question for a topic.
- Sessions run 20 to 40 minutes depending on the session type. Most teachers run a full session about once a week; others replace independent practice with short Daily Practice sessions several times a week.
- Session types: full sessions, Daily Practice (shorter), test prep (several topics), and MyQuest for independent practice.
- Alongside IXL or iReady: many teachers set aside one PeerTeach day a week and keep their other program on other days.

PAIRING AND THE CLASSROOM
- Pairs come from the quick quiz: a student who has mastered the topic with one still learning it, plus how well the two work together (learned from a short student survey and from measured learning in past pairings). Teachers can edit pairs.
- Partners trade roles after every problem, so there's no hierarchy. The stronger student goes first as a model.
- If many students are struggling, those pairs start on an easier prerequisite topic. PeerTeach flags pairs that seem stuck.
- Odd number of students: one trio. Absent students are left out of pairs. Early finishers move on to an extra topic.
- Different levels in one class: groups can work on different topics or grade levels. The teacher can also pull a small group.
- Coaching skills: short whole-class trainings in the first three sessions teach students to ask a question, give a tip, and, if needed, model the solution.
- Devices: each student needs a device for the short quizzes; partners share one device while coaching. Fully digital, no paper version.
- Accommodations: read-aloud and untimed quizzes per student. Students can switch the screen between 25 languages. Calculator availability follows what state tests allow.
- Teachers can't upload their own problems. Questions come in mild, medium and spicy difficulty.
- AI: Mathy is the AI math tutor inside PeerTeach. AI features can be turned off for a whole school or a single teacher.
- Listening to students (if asked how it knows who's talking): the main system most teachers use doesn't listen to students while they coach each other. A beta feature (Strengths Analysis) can analyze the conversation in real time to track each student's coaching strengths and reinforce strong coaching; it knows who's talking from a 30-second voice sample each student records when they first create their account.
- Headphones: most teachers don't have students wear headphones during sessions. They can help in a few short moments along the way: chatting with Mathy for math help, practicing coaching moves, and teaching math to a virtual character.

ENGLISH LEARNERS AND MULTILINGUAL CLASSROOMS
- PeerTeach is designed with multilingual learners in mind. Math content and peer-coaching support are available in multiple languages (students can switch the screen between 25 languages), and students can be paired with classmates who speak their home language.
- Research: our research has found PeerTeach to be the most powerful learning intervention for English Learners in math. Present it as our research's finding ("our research has found..."), never as a promise about their students.
- The study behind it (share ONLY when they ask for details, evidence, the study or the numbers; otherwise the one-sentence finding above is enough): a year-long randomized controlled trial run by independent evaluators, with about 1,000 students across 7 states. PeerTeach students significantly outgrew their classmates in math, and for English learners the effect was particularly strong, at 0.30. The comparison group wasn't sitting idle: those students were using IXL, Freckle, Khan Academy and other well-evidenced math programs. Don't add anything beyond this (no other statistics, author names or publication details); for more, point to peerteach.org.

SETUP, SUPPORT, DATA
- Adding students: Google Classroom import, roster upload, or a join code. Students sign in with Google, Microsoft or Clever.
- Our team (if asked who someone is): Katie Kaplan is our head of school partnerships. Dr. Soren Rosier is the learning scientist who developed PeerTeach at Stanford.
- Onboarding: one call of about 30 to 45 minutes with Katie, our head of school partnerships and a former PeerTeach teacher herself: setting up the account, adding students, walking through a first session. Other math teachers at the school are welcome to join.
- Support: a small, responsive team. Jackie reviews every session each morning and reaches out if something went wrong.
- Data privacy: we regularly complete data privacy agreements with districts, and our team can help with that.
- Teacher dashboard: growth, sessions run, how students rated sessions, class readiness to coach, and each standard broken into strong / developing / limited, with per-student detail.
- Results: across hundreds of thousands of peer coaching sessions, students go from about 28 percent on the pre-quiz to about 60 percent on the exit ticket within a single 15 to 20 minute session. These are averages; never predict a particular class's results.
- Case studies and peer-reviewed research are on peerteach.org.

THE FREE PILOT
- A free one-month pilot, funded by a grant, offered this fall. If they want to start after the fall, our team confirms the details.
- Before it starts, the teacher needs approval from their principal or another school leader (and their district's, if the district requires approval for new tools). The demo gives them a ready-made approval email to send their principal.
- At the end of the month, a school leader reviews the students' learning data with us. That's the main thing we ask of the school.
- After the pilot, if the school wants to continue, there's a per-student cost for the rest of the school year.

PRICES (share only when they ask about cost)
- What to quote depends on today's date: use the PRICE TO QUOTE line above the thread, exactly as it says. Never quote any other per-student numbers.
- The price covers training and coaching, for the rest of the school year after the free pilot.
- District-wide adoption costs less; that's worked out with the district (no number).
- Usually the school pays. Some teachers use classroom budget; mention only if asked.
- Pricing has stayed the same for several years. Never offer discounts, promotions or deadlines.
- Write ranges with "to" ("$18 to $24"), never with a dash.
`.trim();

// Topics where the right answer is "our team will follow up" rather than anything the agent
// writes on its own — straight from Remy's answers.md. Questions about these escalate.
export const TEAM_FOLLOWS_UP = `
- District contracts, purchasing and paperwork details
- Whether other schools in their district use PeerTeach, or anything about a specific named school
- Security details beyond "we regularly complete data privacy agreements"
- Exact quotes beyond the PRICE TO QUOTE line
- Study details beyond what FACTS says about the English Learner trial
- Anything not covered in FACTS
`.trim();


// What we say about cost depends on when we're emailing (Soren, 2026-11-18): starting partway
// through the year is prorated, so the full-year prices would overstate it. Nov 15 to Jan 15:
// about $12 per student for the rest of the year; Jan 16 to Feb 28/29: about $8; Mar 1 to
// Jun 30: no numbers (worked out on a call); from Jul 1: the full-year prices. Dates are
// Eastern, like the NOW line in the context. Used by the teacher and principal agents.
export type PricePeriod = { kind: 'prorated'; perStudent: number } | { kind: 'no_numbers' } | { kind: 'full_year' };

export function pricePeriod(now: Date): PricePeriod {
  const [m, d] = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric' })
    .format(now)
    .split('/')
    .map(Number);
  const md = m * 100 + d; // e.g. Nov 15 = 1115
  if (md >= 1115 || md <= 115) return { kind: 'prorated', perStudent: 12 };
  if (md <= 229) return { kind: 'prorated', perStudent: 8 };
  if (md < 701) return { kind: 'no_numbers' };
  return { kind: 'full_year' };
}

export function priceToQuote(now: Date): string {
  const p = pricePeriod(now);
  if (p.kind === 'prorated') {
    return `Starting now means a prorated price: about $${p.perStudent} per student for the rest of this school year. Say it that way ("about $${p.perStudent} per student for the rest of the year"); never quote a full-year price.`;
  }
  if (p.kind === 'no_numbers') {
    return "Give no price numbers this late in the school year. Say the cost depends on timing and the number of students, and that we'll work it out together when we talk (Katie's Calendly).";
  }
  return 'Per student for the full school year: under 200 students $24, 200 to 499 students $21, 500 or more $18.';
}
