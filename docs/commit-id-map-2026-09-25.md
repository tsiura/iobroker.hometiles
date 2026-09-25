# Commit id map, 2026-09-25

On 2026-09-25 the history was rewritten to change the author and committer
email of every commit; content, dates and messages are unchanged. Commit ids
from before that date, in the docs, in code comments and in test package
names such as `iobroker.hometiles-0.1.0-4cbb6d3.tgz`, refer to the old ids.
This table gives the current id for each. Commits not listed kept their id.

| Old id | Current id | Subject |
| --- | --- | --- |
| `a0bffde` | `7c7c052` | feat(protocol): parse panel announcements with atomic local I/O validation |
| `59a135c` | `429d88f` | docs: bound every list in the announcement parser, not just local_io |
| `bc5231a` | `2b5838c` | fix(protocol): bound every list in the announcement, not just local_io |
| `fed8259` | `26e20a2` | feat(registry): virtual entity types and rename-stable entity ids |
| `3b243e1` | `e6c43a0` | docs: slugify display names whole and cover orphaned id reservation |
| `8f6c3b4` | `7c95450` | fix(registry): slugify display names whole and reserve orphaned ids |
| `2d360f2` | `d261036` | feat(registry): attribute synthesis for sensor, binary sensor and switch |
| `3d07f2a` | `dac5864` | docs: stop numberToState swallowing blanks as zero and stop faking lastChanged |
| `a54ce5d` | `3bc75e3` | fix(registry): treat a blank numeric value as unknown, not zero |
| `a999605` | `95fa132` | docs: guard light readNumber against the same blank-to-zero coercion |
| `87c85fc` | `c9d15de` | feat(registry): light and scene synthesis with channel-derived colour modes |
| `f175aaa` | `85f38c3` | feat(protocol): domain-correct state payloads, bare for sensors, JSON for lights |
| `59b844e` | `10d0538` | docs: make the state payload domain dispatch exhaustive |
| `4fc24c4` | `289876b` | fix(protocol): make the state payload domain dispatch exhaustive |
| `6be91bc` | `000da01` | feat(protocol): bridge/apply and bridge/icons payloads with a stable config signature |
| `f8a48ff` | `b43aa2b` | docs: state_kind for a textual sensor is 'state', not 'text' |
| `890d062` | `542aa91` | fix(protocol): state_kind for a textual sensor is 'state', not 'text' |
| `f76f93b` | `06fe9ec` | feat(protocol): parse and clamp light, switch and scene commands |
| `8c9134b` | `1e69463` | docs: close two holes in the command boundary |
| `f25feb3` | `7de18c2` | fix(protocol): close two holes in the command boundary |
| `66e41e2` | `26b6357` | docs: correct the commands test count, which was stale by one |
| `2b8073d` | `139f74c` | docs: fix blank-to-zero coercion in the panel object tree before dispatch |
| `54d2627` | `ac9a863` | docs: add the covering tests for the blank-payload fixes |
| `b3c373d` | `6424de2` | feat(runtime): MQTT client with reconnect and a bounded drop-oldest publish queue |
| `09cd2ba` | `25343b0` | docs: fix the aedes type and replace fixed sleeps with a bounded poll |
| `b505c8c` | `8a4b8a4` | test: poll instead of sleeping a fixed interval in the MQTT client tests |
| `8ad1ef5` | `9ad6fa2` | docs: isolate MQTT handler dispatch from the emitter |
| `dac9d0a` | `f473fda` | fix(runtime): isolate MQTT handler dispatch from the emitter |
| `1a7461a` | `e56e25c` | feat(runtime): command dispatcher with a fixed per-domain allow-list |
| `dcd78b4` | `d32f33a` | docs: report partial application from the dispatcher, add backend integration note |
| `cd22fb8` | `4531821` | fix(runtime): report how many writes landed before a failure |
| `cd2a66b` | `f2fd594` | docs: measure the transport seam for a cloud-native firmware fork |
| `8f0cc53` | `007cbb8` | docs: scope the transport-replacement verdict to the LAN goal |
| `bd8f1e1` | `5197196` | feat(registry): type-detector mapping to v0.1 domains with object-id keyed overrides |
| `8fabc31` | `fd0b61a` | docs: map the bare ON power channel and stop advertising unwritable colour |
| `ca37a22` | `1aafb68` | fix(registry): map the bare ON power channel and stop advertising unwritable colour |
| `be2092a` | `d631475` | docs: drop telemetry channels the panel never renders |
| `533780b` | `579b7ef` | fix(registry): drop telemetry channels the panel never renders |
| `4318a16` | `4b2c50a` | feat(registry): live entity registry with per-entity coalescing and trailing-edge delivery |
| `57f634b` | `22cc6dd` | docs: explain how test counts actually read, drop stale injectable-now prose |
| `eed1cb4` | `acffa9d` | docs: correct the panel settings contract, wrong on three controls |
| `4769dc4` | `cd87f0a` | feat(runtime): panel sessions with signature-gated config push and command routing |
| `6e61e1b` | `c432b10` | docs: make the forced refresh delegate rather than replay a cached list |
| `b2edc40` | `1cf16ed` | docs: complete the forced-refresh patch that partially applied |
| `d1b491d` | `3885d67` | fix(runtime): delegate a forced refresh instead of replaying a cached list |
| `6e915e8` | `23e8aed` | docs: route a message to one session and cover the manager with tests |
| `12ccae9` | `7fc3697` | fix(runtime): route a message to one session and cover the manager with tests |
| `602fb4f` | `e2c02b3` | docs: drop an unused import from the panel-manager test |
| `25f752d` | `7512615` | feat(runtime): panel object tree, settings echo decoding and local Hardware I/O |
| `c8ccdcf` | `53a7d9c` | docs: restore the finite check on numeric control writes |
| `d724eaf` | `4c9d21c` | fix(runtime): reject a non-finite numeric control write |
| `d56b7f2` | `81ea4df` | feat(runtime): push broker credentials to an unconfigured panel and restart it |
| `4ddaaca` | `d7382fb` | docs: validate the pairing host at both layers |
| `2b7ccfb` | `80b8d07` | fix(runtime): validate the pairing host at both layers |
| `9bc19fb` | `4efab5d` | feat: adapter main wiring, panel object sync and admin message handlers |
| `af4ac4a` | `3e021ff` | fix(test): keep .ts specs on the ts-node require path on Node 22.6+ |
| `706948c` | `1c34189` | docs: give Task 17 the metadata its own package gate requires |
| `0bef2a8` | `25411c9` | fix: add the package metadata the packageFiles gate requires |
| `bc63688` | `4b08662` | feat(admin): JSON config UI with object-id keyed overrides and payload preview |
| `0ad31b6` | `b967584` | docs: assert the admin UI defines every identifier it references |
| `cb02d2e` | `d632f84` | test(admin): assert the UI defines every identifier it references |
| `e1b0637` | `4069c28` | test: end-to-end announce, configure, publish and command round trip |
| `9811f4a` | `3fcff2f` | docs: make the round-trip teardown exception-safe and drop a fixed sleep |
| `9a352bd` | `73f0a86` | docs: README, firmware protocol reference and CI workflow |
| `a8012a3` | `5f83418` | test: make the round-trip teardown exception-safe and drop a fixed sleep |
| `dd46fda` | `c0b7d56` | docs: disclose in the README that nothing has run on hardware |
| `d91daa3` | `29a350b` | docs: state plainly that nothing has run on hardware |
| `6ce6b69` | `79ddc13` | fix: address the whole-branch review findings |
| `c75eadf` | `c5dc9ab` | docs: record the 40 execution rulings |
| `e375c00` | `5a8f1be` | docs: measure the gap to full firmware coverage |
| `4f35f35` | `a8b7a03` | docs: pin the ioBroker half of the v0.2 contract |
| `1bc0ffc` | `ab5fafb` | docs: verified history and energy wire contract |
| `79a565e` | `226a00c` | docs: verified media_player and weather wire contract |
| `bbba050` | `0b61954` | docs: verified editable value wire contract |
| `d62c181` | `da6096c` | docs: verified climate and cover wire contract |
| `3df65d6` | `d784f93` | docs: implementation plan for v0.2 full firmware coverage |
| `7f91082` | `9382444` | chore: ignore the SDD plan workspace |
| `9b30808` | `543757c` | feat(protocol): parameterise the entity state topic leaf |
| `d2719ec` | `0571810` | feat(registry): widen Domain to every supported firmware domain |
| `153ad4b` | `b2d56f8` | feat(registry): detect and synthesise climate entities |
| `362399f` | `48434a5` | fix(registry): stop recompute churn from thermostat VALVE/WINDOW/PARTY, harden SWING test |
| `a4f0b90` | `6ccb758` | feat(protocol): build the complete climate attribute payload |
| `8cc4879` | `663b510` | feat(runtime): dispatch climate commands |
| `6a4752d` | `b16c257` | fix(climate): stop fabricating firmware defaults for presence-flagged fields |
| `ee4cc2f` | `05b451f` | docs(plan): correct three defects found during execution |
| `6438e5d` | `a85c9a5` | fix(runtime): subscribe climate commands, fix fan_mode type, unify preset list |
| `657c99a` | `4c3661c` | fix(runtime): reverse decoded labels back to raw values before writing climate commands |
| `d9153fb` | `24307af` | feat(registry): detect and synthesise cover entities |
| `9b34d31` | `13709f9` | docs(plan): add Task 5b so climate controls are reachable |
| `aed60e5` | `8fe5013` | fix(runtime): make the label encoder an exact inverse, fix fan_mode Ruling 25 |
| `3ab27ef` | `4f30590` | fix(registry): key cover's toggle-vs-position split on channel type, Rulings 27/28 |
| `7962c3c` | `e3c48f0` | fix(registry): normalise all three ioBroker states forms, Ruling 30 |
| `3130a7b` | `5be1377` | feat(protocol): build cover payload with explicit supported_features |
| `8b632f4` | `cb4aa21` | feat(climate): publish *_modes lists and supported_features, Task 5b |
| `e548fe0` | `8100438` | docs(plan): add Task 5c so detection matches the real type-detector |
| `40752a7` | `d441665` | fix(registry): skip id-less detections, trust common.write, Task 5c |
| `d4b8327` | `15b3005` | fix(climate): advertise exactly what can be commanded, Task 5b round 1 |
| `4dc01a2` | `0df928a` | docs(plan): add Task 5d for detection orchestration |
| `41babdd` | `854b80b` | refactor(registry): extract discovery loop so tests drive it, Task 5d step 0 |
| `50314b1` | `52cbc25` | fix(registry): one entity per physical control, Task 5d |
| `6d00c09` | `b997b84` | docs(registry): climate types require a setpoint, Task 5d |
| `28da151` | `2ba49ec` | docs(plan): fold three command-boundary guards into Task 8 |
| `e117228` | `883ad45` | feat(runtime): dispatch cover commands, with three write guards, Task 8 |
| `707404c` | `507d8f0` | fix(synth): read pressure's and warning's own channels, Task 5d round 1 |
| `99273b8` | `9fee873` | fix(registry): never reuse a saved entity id across domains, Task 5d round 1 |
| `95c8e94` | `64ac3b4` | fix(registry): identities that stay with their control, Task 5d round 1 |
| `248f4ae` | `aa4c5b0` | fix(runtime): scale and bound every numeric command, Task 8 round 1 |
| `d5720ca` | `f22bafe` | fix(runtime): a hand-edited store can no longer stop startup, Task 5d round 2 |
| `c8770bf` | `86967c3` | fix(registry): only states make a control, info only surfaces leftovers, Task 5d round 2 |
| `99b1116` | `403efac` | fix(runtime): whole-percent covers, partial light commands, Task 8 round 2 |
| `2fe38b7` | `c1e3096` | fix(registry): a catch-all keeps its own values, Task 5d round 3 |
| `ea5121d` | `62aaabb` | fix(runtime): a failed discovery never publishes an empty world, Task 5d round 3 |
| `0660b0a` | `02449fe` | fix(runtime): a corrupt enum, option or admin request no longer stops startup, Task 5d round 3 |
| `2d063e7` | `6b28b73` | fix(runtime): a colour temperature never blocks power-on; mireds in kelvin, Task 8 round 3 |
| `23ff45f` | `8a91bdf` | fix(registry): a root keeps its own values beside a sub-channel's control, Task 5d round 4 |
| `6a7d1ec` | `996eba0` | fix(runtime): stopping never wipes a panel; one bad device or source is left out, Task 5d round 4 |
| `b4ead95` | `4ce6cce` | feat: media player detection, synthesis and payload, Task 9 |
| `6beccd5` | `e001898` | docs(plan): fold Task 9's three media command facts into Task 10 |
| `301b057` | `bf3b52c` | fix(protocol): no media text value can act as a key the panel reads, Task 9 round 1 |
| `8ea3539` | `53e1451` | fix(registry): a playing position the panel already shows is no change, Task 9 round 1 |
| `ed0e585` | `4934a91` | fix(registry): false is paused, Chromecast's paused is no STATE, COVER says who decides, Task 9 round 1 |
| `ce84e4e` | `b7c043d` | docs(contract): null is not absent for the firmware's string reader |
| `0e03e18` | `4840465` | feat(runtime): dispatch media player commands, Task 10 |
| `58f4424` | `7c79cf8` | docs(contract): the firmware never sends volume_mute |
| `09a2a5b` | `9b5aa09` | feat(registry): synthesise weather from day-indexed channels, Task 11 |
| `eb2a598` | `2667403` | fix(runtime): a SEEK in a time unit is no seek; a mute-only player toggles, Task 10 round 1 |
| `c536f69` | `7868b14` | feat(protocol): parse the four history request shapes off one topic, Task 16 |
| `75dd44f` | `029c897` | fix(registry): weather merge keeps the current icon; views join by identity and hold no root, Task 11 round 1 |
| `6ec216c` | `828f952` | feat(protocol): build index-bucketed numeric history responses, Task 17 |
| `3956a33` | `ee5f413` | docs(contract): correct history/energy size ceilings and call-site ranges |
| `da10d17` | `16165c9` | feat(protocol): weather payload on the weather leaf, answered on request, Task 12 |
| `9ab40e6` | `cd26530` | fix(protocol): empty periods carry the reading in effect; a malformed range gets no response, Task 17 round 1 |
| `43b72d9` | `b336df5` | feat(registry): synthesise number, select and datetime entities, Task 13 |
| `471e3d1` | `0976ac8` | fix(weather): canonical day conditions, key-named text, OpenWeatherMap dates, Task 12 round 1 |
| `5ead273` | `a1be5ca` | docs(contract): weather readers, placeholders and dates, as verified (CC1-CC12) |
| `3be9427` | `43e4443` | docs(plan): add Task 13b, manual entities |
| `f01f049` | `f5b2402` | feat(registry): manual entities by state id and domain, Task 13b |
| `0cc3e81` | `73b5c61` | fix(registry): derived steps, percent numbers, epoch dates, one level per root, Task 13 round 1 |
| `43d1c18` | `9e09cac` | fix(registry): explain read-only manual values, declared datetime kinds, Task 13b round 1 |
| `ff50f21` | `83fb814` | fix(registry): a read-only level is no adjustable level; count a root's own levels only, Task 13 round 2 |
| `914bd67` | `a8f8fb3` | feat(protocol): build and publish the editable /control payload, Task 14 |
| `3d0c54a` | `6916833` | fix(protocol): degrade an oversize /control, refuse lone surrogates, Task 14 round 1 |
| `45f02d3` | `04435dc` | feat(runtime): handle cmnd/value and answer on stat/value, Task 15 |
| `2f9fbd7` | `e2af324` | fix(runtime): ignore retained commands on every leaf, warn on clock skew, Task 15 round 1 |
| `526ef5b` | `f19cb7a` | fix(runtime): warn from 2 s beyond the clock window, Task 15 round 2 |
| `d062687` | `6a1fd11` | feat(protocol): publish the v0.2 entity lists and meta sections, Task 21 |
| `ec8c88f` | `4acfb62` | fix(protocol): send bridge/apply only what a panel parses, Task 21 round 1 |
| `50f4c18` | `4668a9d` | fix(protocol): keep bridge/icons within the panel's 32767 bytes, Task 21 round 2 |
| `441de93` | `7c372cd` | docs(plan): add Task 21b, opt-in entity selection |
| `e0ceb48` | `81c73ad` | feat(registry): opt-in entity selection with a detected-devices picker, Task 21b |
| `83fb430` | `ced5f47` | fix(registry): a picker refresh moves none of the form's rows, Task 21b |
| `44d1111` | `d780de5` | fix(registry): hold back an apply with every list empty; deletable, marked picker rows, Task 21b round 1 |
| `4cbb6d3` | `dda9de3` | fix(registry): publish nothing until the Devices tab is used; rows stay put, Task 21b round 2 |
| `9733672` | `17e8645` | fix(registry): bump the picker marker, keep manual ids and unreadable rows, Task 21b round 3 |
| `30762e9` | `fc5dc9f` | feat(protocol): build binary, state and editable history responses, Task 18 |
| `4cad873` | `d58e6c4` | docs(plan): add Task 20b, energy meters |
| `3691af3` | `5101ab2` | feat(runtime): read panel history as raw rows from the history instance, Task 19 |
| `566755e` | `96b4547` | test(integration): run the history provider against iobroker.history, Task 19 |
| `ae09d3b` | `fb75fac` | docs(contract): correct the ioBroker history contract from the adapters' sources, Task 19 |
| `6ac07da` | `7e76718` | test(runtime): correct two js-controller line references, Task 19 |
| `37b9e87` | `ef7d2a4` | fix(protocol): editable Number graph in effect, "History unavailable", Task 18 round 1 |
| `191eb26` | `3d2788c` | feat(protocol): energy request parsing and response building, Task 20 |
| `9beb36e` | `aa97ccd` | feat(runtime): the reading before each energy bucket boundary, Task 20b |
| `3fa3b38` | `1e37d4d` | feat(config): energy meters and their currency on an Energy tab, Task 20b |
| `1f4f094` | `4869ada` | feat(runtime): energy answers and the bridge/apply energy catalog, Task 20b |
| `6ee7899` | `f65b902` | test(integration): energy meters through the adapter and a real iobroker.history, Task 20b |
| `336d854` | `89425a5` | docs(contract): the energy response and catalog as v0.6.12 reads them, Tasks 20/20b |
| `25e65b7` | `abd7d87` | test(admin): the json-config lines a select keeps its value at, Task 20b |
| `f66b6a0` | `ee1fc9f` | docs(runtime): when prior() looks back, and why an empty answer is final, Task 20b |
| `66a315f` | `1779510` | docs(plan): correct the energy null/absent rule in Global Constraints |
| `ee8adaa` | `6c6ec23` | fix(runtime): history provider review round 1, Task 19 (Ruling 130) |
| `287b863` | `fd6aa8a` | test(integration): skip the iobroker.history suite when it cannot be installed, Task 19 (M-7) |
| `4482cb7` | `bef6955` | docs(contract): the history review's gaps, Task 19 round 1 (M-9) |
| `604196f` | `db9d67c` | fix(runtime): keep prior()'s look-back when the week before holds no row, Task 19 round 1 |
| `f3e3053` | `7bbf019` | test(runtime): pin per-state boundary readings, settling midnights and stored meter ids, energy round 1 |
| `0fb5ca0` | `cb452a4` | fix(runtime): an energy total spans the hours no window reached, energy round 1 |
| `b872a94` | `1028c6b` | fix(registry): no meter id ends in _cost, stored ones are checked, the currency capped, energy round 1 |
| `f1bdeb0` | `9b3333c` | docs(admin): the Energy tab asks for counters that only grow, never a daily one, energy round 1 |
| `d9821f9` | `726d592` | fix(main): armed energy meters are content: their apply goes out alone, energy round 1 |
| `30b2a43` | `857c196` | feat(runtime): the house's consumption and what no device accounts for, energy round 1 |
| `cd9bb6b` | `d940c7c` | fix(runtime): one budget per energy answer, the slot wait included, meters two at a time, energy round 1 |
| `076159f` | `2dbbe5a` | fix(runtime): a deadline per history query, the slot wait included; N1-N3 and N6, Task 22 |
| `aa4ecf1` | `7de5297` | feat(runtime): answer each panel's history and energy requests, Task 22 |
| `7ef636d` | `e43ffc3` | test(integration): a panel's history and energy requests answered through the adapter, Task 22 |
| `39bf711` | `c690f6d` | test(runtime): pin where a history is read from, the look-back's count and a row read alone, Task 22 |
| `2f7cc85` | `cb7731e` | fix(config): a device meter is consumption only, sign 1, energy round 2 |
| `efedeaf` | `19bd291` | fix(runtime): the house's consumption is known only where every electric meter is, energy round 2 |
| `2e5e0c0` | `9722f0b` | test(runtime): a kept meter is never late, and water feeds no consumption, energy round 2 |
| `a44b13c` | `9c2dc7f` | docs(admin): the Energy tab gives the signs the house's consumption uses, energy round 2 |
| `f02da77` | `0db74b2` | test(registry): the reverse case tests a cost id that is a meter's, energy round 2 |
| `f980f33` | `b7f1321` | fix(runtime): say when bridge/icons goes out without its clearing entries, Task 23 |
| `51ddb2f` | `f122f82` | fix(energy): keep a device meter at -1 as 1, and name what an unlogged electric meter blanks, Task 23 |
| `5bb642d` | `43c53e5` | feat(admin): force any published domain, preview each picker row, offer devices no export sign, Task 23 |
| `2fb038e` | `b71b222` | fix(admin): name a forced type that makes no tile; Test broker and Pair take what is typed, Task 23 round 1 |
| `1a19f47` | `0e8a3b4` | fix(admin): map a thermostat's own modes, preview as saving does, encrypt the broker password, Task 23 round 2 |
| `83ae66d` | `b56c0be` | test: ephemeral ports, fake clocks for sleeps, request unsubscription pinned, Task 24 |
| `a4d2793` | `d1b5e37` | test(integration): free database ports, loud npm failures, barriers, round trips per domain, Task 24 |
| `fe00350` | `c8162c2` | test(integration): hold a helper back before the Devices tab is saved, Task 24 |
| `fc28837` | `32c5633` | fix(config): never use or push a broker password that could not be decrypted, Task 23 round 3 |
| `6d4d151` | `ae56d8f` | docs: document the v0.2 domains and release 0.2.0, Task 25 |
| `feccd13` | `7241727` | test(integration): own broker ports, history apart, every write, guarded harness, Task 24 round 1 |
| `20da38b` | `e7d6ee3` | test(integration): run the harness on js-controller 7.2.2, not the moving dev tag (m6) |
| `438e21d` | `bc7068e` | ci: run the integration suite; docs: one TMPDIR per concurrent run (m4, m5) |
| `ce0b6aa` | `fb5d508` | Bound the start's js-controller calls and leave out unreadable aliases |
| `d2cab95` | `92556be` | Guard the password migration and pairing, and explain a refused login |
| `04d43c7` | `6b3a598` | Correct the 0.2.0 docs and meet the repository checker |
| `0b4e671` | `db18b30` | docs(plan): add Task 25b, panel battery charge |
| `f83b404` | `421e906` | Read the panel's battery charge into panels.<id>.info.battery (Task 25b) |
| `7147c73` | `d78ba94` | Keep a catch-all root on its recorded reading (final review FIX 1) |
| `889757a` | `05a362f` | Update mqtt to ^5.16.0 and pin type-detector to ~6.0.1 (final review FIX 2, FIX 10) |
| `f2c726e` | `ea07cbc` | Reconnect after a refused MQTT login and throttle repeated errors (final review FIX 2) |
| `8bd4109` | `72cfe08` | Give a re-announcing panel every entity state again (final review FIX 3) |
| `13edf52` | `72fefea` | Stop onReady once unloading, and unsubscribe offline at once (final review FIX 4) |
| `231b025` | `bb37897` | Migrate the broker password only where the instance declares it encrypted (final review FIX 5) |
| `d557dac` | `50c4428` | Subscribe aliases whose target is missing, and name them (final review FIX 6) |
| `0b2d60f` | `fc322aa` | Bound the history instance checks by the answer's deadline (final review FIX 7) |
| `e4345df` | `7917a07` | Set only …paused aside as a media STATE, and name picked devices that make no tile (final review FIX 8) |
| `698fcad` | `74830dc` | Send no friendly_name in climate and light state payloads (final review FIX 9) |
| `882a9d5` | `a6224d8` | Mark the adapter nogit and pin type-detector in the package test (final review FIX 10) |
| `1590a14` | `44c5f1c` | Run the CI integration job on Node 22 and 24, and bound both jobs (final review FIX 11) |
| `8589710` | `3ff16cc` | Test the startup bounds and fix the startup-test tooling nits (final review FIX 12) |
| `ef345b3` | `fc56f45` | Make three tests say and check what they mean (final review FIX 13) |
| `36ca1b5` | `e208a14` | Correct two stale comments (final review FIX 14) |
| `a41e91d` | `b2233b5` | Accept only an id-shaped device id from the announce topic (final review FIX 15) |
| `7c340af` | `7fb2078` | Document the accepted limitations in the README (final review FIX 16) |
| `b46d274` | `8fd8ee6` | Tighten two comments and the stop test's precondition (fix wave self-review) |
| `6648c91` | `0e3a300` | docs: list the reconnect snapshot and battery charge as hardware checks |
| `b0fa1a4` | `1f64705` | docs(plan): record the v0.2 execution rulings and final-review triage |
| `49c2d2e` | `7d33a87` | docs: add a step-by-step guide from zero to a working panel |
