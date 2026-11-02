// Word lists for the name heuristics. Plain data, no logic.
//
// FIRST_NAMES holds common given names that are not also everyday English words, so a
// capitalised pair like "Sarah Connor" is read as a person while "Will Smith" style
// ambiguity is left to the other rules (context, the always-mask list). SURNAMES lets a
// pair like "Alex Johnson" match when the first word is rare. NOT_NAME_WORDS are
// capitalised words that must never start or join a name (sentence openers, tech words,
// company suffixes, days, months, places that look like names).

const set = (s: string) => new Set(s.toLowerCase().split(/\s+/).filter(Boolean))

export const FIRST_NAMES = set(`
aaron abdul wei ming jun hui xin hao lei jing ying ling fang tao yuki hiro kenji takeshi haruto sakura akira abdullah abigail adam adrian adriana ahmed aisha alan albert alejandro alex alexander alexandra alexis alfred ali alice alicia alina
alison allan allen alma amanda amelia amina amir amit amita amy ana anand anastasia andre andrea andreas andrew andy angela angelica angelo anita ann
anna anne annie anthony antoine anton antonio anya arjun arthur arun asha ashley ashok astrid ava barbara barry beatrice beatriz becky ben benjamin
bernard beth bethany betty beverly bianca bilal bjorn bob bobby bonnie boris brad bradley brandon brenda brendan brian bridget brittany bruce bryan
caitlin caleb camila carl carla carlos carmen carol carolina caroline carolyn catherine cathy cecilia cedric celine charlene charles charlie charlotte
cheryl chloe chris christian christina christine christopher cindy clara clare clarence claudia claudio colin connor conrad constance cora corey
courtney craig cristina curtis cynthia daisy dale damian damon dana daniel daniela danielle danny dara darius darren dave david debbie deborah debra
denis denise dennis derek diana diane diego dimitri dina dmitri dominic dominique donald donna doris dorothy douglas duncan dylan eddie edgar edith
eduardo edward edwin eileen elaine eleanor elena eli elias elijah elisa elisabeth elizabeth ella ellen elliot emil emilia emily emma enrique erica
erik erika erin ernest esther ethan eugene eva evan evelyn fabian farah fatima felix fernando fiona francesca francis francisco franco fred frederick
gabriel gabriela gabriella gareth gavin george gerald geraldine gerard gianna gideon gilbert gina giovanni gladys glen glenn gloria gordon greg
gregory gretchen guillermo gustavo hamza hana hannah hans harold harry hassan hayley hector heidi helen helena henrik henry herbert hiroshi howard
hugh hugo hussein ian ibrahim igor imran ingrid irene isaac isabel isabella isabelle ishaan ivan jacob jacqueline jakob james jamie jan jane janet
janice jared jasmine jason javier jay jeff jeffrey jenna jennifer jenny jeremy jerome jerry jesse jessica jesus jill jim jimmy joan joanna joanne
joaquin jochen joe joel johan johanna john johnny jon jonas jonathan jorge jose josef joseph josephine joshua josh juan juanita judith judy julia
julian juliana julie julien julio justin kai kamal karen karim karl karla kate katherine kathleen kathryn kathy katie katrina kayla keith kelly ken
kenneth kevin khalid kim kimberly kiran kirsten kofi kristen kristin kristina krystal kumar kyle lakshmi lana lars laura lauren laurent laurie
lawrence layla leah lee leila lena leo leon leonard leonardo leslie liam lina linda lindsay lisa liz lloyd lola lorenzo lori lorraine lou louis louise
lucas lucia luciana lucy luis luisa luke luna luther lydia lynn mabel madeline madison magnus mahmoud malcolm malik manuel marc marcel marcelo marco
marcus margaret margarita maria mariam marian marianne marie mario marion marisa marissa marta martha martin martina marvin mary maryam mateo mathew
mathias matilda matt matthew matthias maurice mauricio maxim maxime maya megan mehdi mei melanie melinda melissa meredith mia michael michaela michel
michele michelle miguel mika mike mikhail miles miriam mohamed mohammad mohammed mohan monica moses muhammad nadia nadine nancy naomi natalia natalie
natasha nathan nathaniel neil nelson neha nicholas nick nicolas nicole nigel nikhil nikita nikolai nina noah noor nora norman olga oliver olivia omar
oscar otto owen pablo paige pamela paola patricia patrick paul paula pauline pavel pedro peggy peter petra philip philipp phillip pierre pooja pradeep
priya rachel rafael rahul raj rajesh rajiv ralph ramon ramona randy raquel rashid raul raymond rebecca regina reginald reid renata rene ricardo
richard rick ricky rita robert roberta roberto robin rodney rodrigo roger roland roman ron ronald ronnie rosa rosemary roy ruben rudolf russell ruth
ryan sabrina sachin sadie saeed sally salma salman sam samantha samir samuel sandra sanjay santiago sara sarah saul scott sean sebastian selena serena
sergei sergio seth shane shannon sharon shawn sheila shelley shirley shreya sidney sigrid silvia simon simone sofia sonia sonja sophia sophie stacy
stan stanley stefan stefanie stella stephan stephanie stephen steve steven stuart sunil susan susanna suzanne svetlana sven sylvia tamara tammy tania
tanya tara tariq tatiana ted teresa teresa terri tessa theo theodore theresa thomas tim timothy tina tobias todd tom tomas tommy toni tony tracy
travis trevor tristan troy tyler uma ulrich ursula valentina valerie vanessa vera veronica vicky victor victoria vijay vikram vince vincent viola
virginia vivian vladimir walter wanda warren wayne wendy wesley wilhelm william willie winston xavier yasmin yasmine yara yasir yosef youssef yuki
yusuf yvonne zachary zack zara zoe zoey
`)

/** Given names that are also everyday words or brands: a name only when a common surname follows. */
export const AMBIGUOUS_FIRST = set(`will mark may grace bill art hope faith joy pat sue rob ray jack max frank dean jean jordan austin chase dawn kent page mason morgan logan taylor cameron devon blake casey drew grant ross lee`)

export const SURNAMES = set(`
adams ahmed ali allen alvarez anderson andersson ansari bailey baker banerjee barnes bell bennett bhatt brooks brown bryant butler campbell carter castillo chaudhry chavez chen clark coleman collins cook cooper cox cruz cunningham davies davis diaz dixon edwards ellis evans fernandez fischer fisher flores ford foster fox garcia gibson gomez gonzalez gonzales gordon graham grant gray green griffin gupta gutierrez hall hamilton harris hart hayes henderson hernandez hill howard hughes hunt hussain ibrahim jackson jain james jenkins jimenez johansson johnson jones jordan joshi kaur kelly kennedy khan kim king klein knight kowalski kumar lee lewis li lin lopez lucas macdonald malik marshall martin martinez mason mccarthy mcdonald mehta mendoza meyer miller mitchell mohammed moore morales moreno morgan morris murphy murray myers nair nelson nguyen nichols nielsen o'brien oliveira olsen ortiz owens palmer parker patel patterson perez perry peters petersen phillips powell price quinn ramirez ramos reddy reed reyes reynolds richardson rivera roberts robertson robinson rodriguez rodrigues rogers rojas romero rose ross rossi russell ryan salazar sanchez sanders santos schmidt schneider schulz scott sharma shaw shah silva simmons simpson singh smith sokolov soto spencer stevens stewart stone sullivan suzuki tan taylor thomas thompson torres tran turner verma wagner walker wallace wang ward watson webb weber wells west white williams wilson wong wood wright xu yadav yang young zhang zhao zhou zimmerman
`)

export const NOT_NAME_WORDS = set(`
a about above after again all also am an and any are as at back be because been before being below best between both but by can come could day days did do does done down each end even every few first for from get give go good great had has have he hello her here hey hi him his how i if in into is it its just last let like look make many may me more most much my new next no not now of off on one only open or other our out over own please really run said same say see she should since so some still such take than thank thanks that the their them then there these they thing this those through to too two under up us use used using very want was way we well were what when where which while who why will with would yes yet you your
monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october november december
mr mrs ms miss mx dr prof sir dame inc llc ltd limited corp corporation company co gmbh plc pty ag bv sa srl
world everyone everybody there folks guys friends all sir madam buddy mate again team group department dept support sales engineering marketing finance legal operations platform services service customer customers client clients user users admin administrator owner manager director officer assistant agent system systems product products project projects store shop shopify theme app apps site website page pages order orders invoice invoices payment payments account accounts report reports summary status issue issues task tasks ticket tickets note notes email emails phone phones name names address total price amount balance cost fee tax shipping billing delivery return returns refund refunds discount code codes
api cli sdk url html css json yaml sql git github gitlab slack notion figma google gmail drive docs sheets calendar claude anthropic openai chatgpt gemini copilot cursor vscode code typescript javascript python react node npm yarn pnpm docker kubernetes aws azure gcp linux macos windows android ios iphone ipad chrome safari firefox edge
new york london paris berlin tokyo delhi mumbai sydney dubai singapore toronto amsterdam madrid rome vienna zurich geneva dublin boston chicago seattle austin denver miami atlanta houston dallas phoenix america europe asia africa india china japan germany france spain italy brazil mexico canada australia england scotland wales ireland
open source studio visual basic express web cloud data design editor manager server client desktop mobile android home work office main street road avenue lane drive court way park square hill valley river lake mountain island bay beach city town village county state
note warning error info debug fixme todo hack success failed failure pending done active inactive enabled disabled yes no ok
`)

/** Words never drawn as a name by the automatic rules (the person can add more). */
export const DEFAULT_ALLOW = [
  'Claude', 'Claude Code', 'Anthropic', 'Sonnet', 'Opus', 'Haiku', 'GitHub', 'Shopify', 'Notion', 'Slack', 'Figma', 'Google', 'Gmail',
  'Screen Share', 'Brain Dump', 'Cache Clock', 'Chat Inventory', 'Helper Desk',
]
