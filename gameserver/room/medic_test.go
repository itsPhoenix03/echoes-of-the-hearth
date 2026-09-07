package room

import (
	"math"
	"testing"

	"hearth/gameserver/world"
)

// The medic bargain is the most tuned piece of Slice 4, so these tests pin down
// the properties a refactor could silently break: the two client-visible
// windows (60 s expiry, 20 s reroll), offer stability across repeat inspects,
// the exact rejection reason strings, the combat lockout, and — the one that
// actually costs a player something if it regresses — that a rejected accept
// never deducts.

// atMedic puts the player next to a medic, injured, out of combat and with the
// medic frame cooldown clear.
func (f *fixture) atMedic(md *world.Medic) {
	f.p.X, f.p.Y, f.p.Z = float64(md.X)+1, float64(md.Y), 0
	f.p.HP = 4
	f.p.LastDamageAt = 0
	f.p.LastMedicAt = 0
	f.p.LastPosAt = f.now
	f.p.WarpUntil = 0
}

// medicOf returns the medic for an island id.
func (f *fixture) medicOf(t *testing.T, island string) *world.Medic {
	t.Helper()
	for i := range f.r.medics {
		if f.r.medics[i].IslandID == island {
			return &f.r.medics[i]
		}
	}
	t.Fatalf("no medic on %s", island)
	return nil
}

// inspect / accept / decline drive the handler with the cooldown cleared, so
// back-to-back calls in a test are never swallowed by the 200 ms spam damper.
func (f *fixture) inspect(md *world.Medic) map[string]any {
	f.p.LastMedicAt = 0
	f.reset()
	f.r.handleMedic(f.p, map[string]any{"t": "medic", "medicId": md.ID, "action": "inspect"})
	if o := f.lastOfType("medicOffer"); o != nil {
		return o
	}
	return f.lastOfType("medicResult")
}

func (f *fixture) accept(md *world.Medic, offerID string) map[string]any {
	f.p.LastMedicAt = 0
	f.reset()
	f.r.handleMedic(f.p, map[string]any{
		"t": "medic", "medicId": md.ID, "action": "accept", "offerId": offerID,
	})
	return f.lastOfType("medicResult")
}

// offerIDOf digs the id out of a medicOffer frame.
func offerIDOf(t *testing.T, m map[string]any) string {
	t.Helper()
	if m == nil {
		t.Fatal("expected a medicOffer, got nothing")
	}
	o, ok := m["offer"].(map[string]any)
	if !ok {
		t.Fatalf("medicOffer carried no offer: %v", m)
	}
	id, _ := o["id"].(string)
	if id == "" {
		t.Fatalf("offer has no id: %v", o)
	}
	return id
}

func reasonOf(t *testing.T, m map[string]any) string {
	t.Helper()
	if m == nil {
		t.Fatal("expected a medicResult, got nothing")
	}
	if ok, _ := m["ok"].(bool); ok {
		t.Fatalf("expected a rejection, got a success: %v", m)
	}
	s, _ := m["reason"].(string)
	return s
}

// --- stability and the two timers -----------------------------------------

func TestMedicOfferStableAcrossRepeatInspects(t *testing.T) {
	f := newFixture(t)
	md := f.medicOf(t, "woods")
	f.atMedic(md)

	first := offerIDOf(t, f.inspect(md))
	for n := 0; n < 5; n++ {
		f.now += 1000 // still inside the 60 s window
		if got := offerIDOf(t, f.inspect(md)); got != first {
			t.Fatalf("inspect %d rerolled the offer: %s -> %s", n, first, got)
		}
	}
	// The advertised expiry counts down rather than resetting: 5 s of the 60 s
	// window has been consumed by the loop above.
	o := f.inspect(md)["offer"].(map[string]any)
	if left := int64(o["expiresInMs"].(float64)); left != medicOfferTTLMs-5000 {
		t.Fatalf("expiresInMs should have decayed to %d, got %d", medicOfferTTLMs-5000, left)
	}
}

func TestMedicOfferExpiryAndRerollDelay(t *testing.T) {
	f := newFixture(t)
	md := f.medicOf(t, "woods")
	f.atMedic(md)

	first := offerIDOf(t, f.inspect(md))

	// One millisecond before the 60 s TTL the offer is still the same one.
	f.now += medicOfferTTLMs - 1
	if got := offerIDOf(t, f.inspect(md)); got != first {
		t.Fatalf("offer expired early: %s -> %s", first, got)
	}

	// Crossing the TTL both drops the offer and starts the 20 s reroll delay,
	// so the very inspect that notices the expiry is refused.
	f.now += 1
	if r := reasonOf(t, f.inspect(md)); r != "rate-limited" {
		t.Fatalf("expiry should cost a reroll delay, got reason %q", r)
	}
	f.now += medicRerollMs - 1
	if r := reasonOf(t, f.inspect(md)); r != "rate-limited" {
		t.Fatalf("still rate-limited 1 ms before the 20 s reroll, got %q", r)
	}
	f.now += 1
	second := offerIDOf(t, f.inspect(md))
	if second == first {
		t.Fatalf("a fresh offer reused the expired id %s", second)
	}
}

func TestMedicDeclineCostsRerollDelay(t *testing.T) {
	f := newFixture(t)
	md := f.medicOf(t, "woods")
	f.atMedic(md)
	first := offerIDOf(t, f.inspect(md))

	f.p.LastMedicAt = 0
	f.reset()
	f.r.handleMedic(f.p, map[string]any{"t": "medic", "medicId": md.ID, "action": "decline"})
	declined := f.lastOfType("medicOffer")
	if declined == nil {
		t.Fatal("decline sent no medicOffer")
	}
	if declined["offer"] != nil {
		t.Fatalf("decline should clear the offer, got %v", declined["offer"])
	}
	// The declined offer is gone: accepting it now is a mismatch, not a heal.
	if r := reasonOf(t, f.accept(md, first)); r != "offer-mismatch" {
		t.Fatalf("declined offer was still spendable: %q", r)
	}
	f.now += medicRerollMs - 1
	if r := reasonOf(t, f.inspect(md)); r != "rate-limited" {
		t.Fatalf("decline should rate-limit for 20 s, got %q", r)
	}
	f.now += 1
	if got := offerIDOf(t, f.inspect(md)); got == first {
		t.Fatalf("post-decline offer reused the declined id %s", got)
	}
}

// --- atomicity ------------------------------------------------------------

// The property that matters: every path that refuses to heal must also refuse
// to charge. This drives each rejection in turn and asserts the resource
// counter and hp are both untouched.
func TestMedicAcceptNeverDeductsWithoutHealing(t *testing.T) {
	f := newFixture(t)
	md := f.medicOf(t, "woods")
	f.atMedic(md)
	_ = offerIDOf(t, f.inspect(md))
	offer := f.r.medicOffers[f.p.S.ID]
	if offer == nil {
		t.Fatal("no offer was recorded server-side")
	}
	res, amt := offer.Resource, offer.Amount

	type tc struct {
		name    string
		prepare func()
		offerID string
		reason  string
	}
	cases := []tc{
		{"insufficient-resource", func() { f.p.Inv[res] = amt - 1 }, offer.ID, "insufficient-resource"},
		{"full-health", func() { f.p.Inv[res] = amt + 5; f.p.HP = f.r.defs.MaxHP }, offer.ID, "full-health"},
		{"dead", func() { f.p.Inv[res] = amt + 5; f.p.HP = 0 }, offer.ID, "dead"},
		{"offer-mismatch", func() { f.p.Inv[res] = amt + 5; f.p.HP = 4 }, "someone-elses-offer:1", "offer-mismatch"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			c.prepare()
			// re-arm: the guards above may have cleared or aged the offer
			f.r.medicOffers[f.p.S.ID] = offer
			offer.ExpiresAt = f.now + medicOfferTTLMs
			before, hpBefore := f.p.Inv[res], f.p.HP

			if got := reasonOf(t, f.accept(md, c.offerID)); got != c.reason {
				t.Fatalf("reason: want %q got %q", c.reason, got)
			}
			if f.p.Inv[res] != before {
				t.Fatalf("a refused bargain charged the player: %s %d -> %d", res, before, f.p.Inv[res])
			}
			if f.p.HP != hpBefore {
				t.Fatalf("a refused bargain moved hp: %d -> %d", hpBefore, f.p.HP)
			}
		})
	}

	// offer-expired is the fifth path and needs the clock rather than state.
	f.p.Inv[res], f.p.HP = amt+5, 4
	f.r.medicOffers[f.p.S.ID] = offer
	offer.ExpiresAt = f.now - 1
	before := f.p.Inv[res]
	if got := reasonOf(t, f.accept(md, offer.ID)); got != "offer-expired" {
		t.Fatalf("expired accept: want offer-expired got %q", got)
	}
	if f.p.Inv[res] != before || f.p.HP != 4 {
		t.Fatalf("an expired bargain charged the player: %s=%d hp=%d", res, f.p.Inv[res], f.p.HP)
	}
}

// The success path: pay exactly the quoted amount, heal all the way to MAX_HP,
// and consume the offer so it cannot be replayed.
func TestMedicAcceptPaysOnceAndHealsToFull(t *testing.T) {
	f := newFixture(t)
	md := f.medicOf(t, "woods")
	f.atMedic(md)
	_ = offerIDOf(t, f.inspect(md))
	offer := f.r.medicOffers[f.p.S.ID]
	res, amt := offer.Resource, offer.Amount

	f.p.Inv[res] = amt + 7
	f.p.HP = 3
	got := f.accept(md, offer.ID)
	if ok, _ := got["ok"].(bool); !ok {
		t.Fatalf("accept failed: %v", got)
	}
	if f.p.HP != f.r.defs.MaxHP {
		t.Fatalf("treatment must restore full health: hp=%d", f.p.HP)
	}
	if healed := got["healed"].(float64); int(healed) != f.r.defs.MaxHP-3 {
		t.Fatalf("healed should be the missing amount (%d), got %v", f.r.defs.MaxHP-3, healed)
	}
	if f.p.Inv[res] != 7 {
		t.Fatalf("paid the wrong amount: %s left %d, want 7", res, f.p.Inv[res])
	}
	paid, _ := got["paid"].(map[string]any)
	if paid == nil || paid["resource"] != res || int(paid["amount"].(float64)) != amt {
		t.Fatalf("paid receipt wrong: %v (want %s x%d)", paid, res, amt)
	}
	// Consumed: the same offer id cannot be spent twice.
	f.p.HP = 3
	if r := reasonOf(t, f.accept(md, offer.ID)); r != "offer-mismatch" {
		t.Fatalf("a spent offer was replayable: %q", r)
	}
	if f.p.Inv[res] != 7 {
		t.Fatalf("the replay charged the player again: %d", f.p.Inv[res])
	}
}

// --- the gates ------------------------------------------------------------

func TestMedicRejectionGates(t *testing.T) {
	f := newFixture(t)
	md := f.medicOf(t, "woods")

	// unknown medic
	f.atMedic(md)
	f.p.LastMedicAt = 0
	f.reset()
	f.r.handleMedic(f.p, map[string]any{"t": "medic", "medicId": "medic-nowhere", "action": "inspect"})
	if r := reasonOf(t, f.lastOfType("medicResult")); r != "unknown-medic" {
		t.Fatalf("unknown medic: %q", r)
	}

	// underground / indoors
	f.atMedic(md)
	f.p.Z = 1
	if r := reasonOf(t, f.inspect(md)); r != "wrong-level" {
		t.Fatalf("wrong level: %q", r)
	}

	// just outside the 2.5-tile radius
	f.atMedic(md)
	f.p.X = float64(md.X) + 2.6
	if r := reasonOf(t, f.inspect(md)); r != "too-far" {
		t.Fatalf("too far: %q", r)
	}
	// and just inside it
	f.atMedic(md)
	f.p.X = float64(md.X) + 2.4
	if id := offerIDOf(t, f.inspect(md)); id == "" {
		t.Fatal("2.4 tiles should be in range")
	}

	// full health: no bargain is offered at all
	f.atMedic(md)
	f.p.HP = f.r.defs.MaxHP
	if r := reasonOf(t, f.inspect(md)); r != "full-health" {
		t.Fatalf("full health: %q", r)
	}

	// dead
	f.atMedic(md)
	f.p.HP = 0
	if r := reasonOf(t, f.inspect(md)); r != "dead" {
		t.Fatalf("dead: %q", r)
	}
}

// The combat lockout: 5 s after the last combat hit, and not a millisecond
// less. It is keyed on LastDamageAt, which only combat stamps.
func TestMedicCombatLockout(t *testing.T) {
	f := newFixture(t)
	md := f.medicOf(t, "woods")
	f.atMedic(md)

	f.p.LastDamageAt = f.now
	if r := reasonOf(t, f.inspect(md)); r != "in-combat" {
		t.Fatalf("mid-fight inspect should be refused, got %q", r)
	}
	f.now += medicCombatLockMs - 1
	if r := reasonOf(t, f.inspect(md)); r != "in-combat" {
		t.Fatalf("still locked 1 ms early, got %q", r)
	}
	f.now += 1
	id := offerIDOf(t, f.inspect(md))

	// Taking a hit mid-dialogue re-locks the accept, and the offer survives it.
	f.p.LastDamageAt = f.now
	f.p.Inv["wood"], f.p.Inv["fiber"], f.p.Inv["stone"], f.p.Inv["meat"] = 99, 99, 99, 99
	if r := reasonOf(t, f.accept(md, id)); r != "in-combat" {
		t.Fatalf("accept during combat should be refused, got %q", r)
	}
	f.now += medicCombatLockMs
	res := f.accept(md, id)
	if ok, _ := res["ok"].(bool); !ok {
		t.Fatalf("the offer should have survived the lockout: %v", res)
	}
}

// Environmental chip damage must NOT lock the medic out — otherwise the Spire
// medic is unreachable without the Fur Cloak you would be visiting them to
// survive without.
func TestMedicEnvironmentalDamageDoesNotLock(t *testing.T) {
	f := newFixture(t)
	md := f.medicOf(t, "spire")
	f.atMedic(md)
	f.p.HP = 5
	// Run the environmental tick the Spire medic's own snow tile produces.
	f.r.tickN = 25
	f.r.survivalTick()
	if f.p.LastDamageAt != 0 {
		t.Fatalf("survivalTick stamped LastDamageAt (%d) — the medic lockout would never clear", f.p.LastDamageAt)
	}
	f.p.HP = 5
	f.p.LastMedicAt = 0
	if id := offerIDOf(t, f.inspect(md)); id == "" {
		t.Fatal("environmental damage locked the medic out")
	}
}

// The 200 ms per-player floor: a burst of frames produces one answer, silently.
func TestMedicSpamDamper(t *testing.T) {
	f := newFixture(t)
	md := f.medicOf(t, "woods")
	f.atMedic(md)
	f.reset()
	f.r.handleMedic(f.p, map[string]any{"t": "medic", "medicId": md.ID, "action": "inspect"})
	f.r.handleMedic(f.p, map[string]any{"t": "medic", "medicId": md.ID, "action": "inspect"})
	f.r.handleMedic(f.p, map[string]any{"t": "medic", "medicId": md.ID, "action": "inspect"})
	n := 0
	f.seen = append(f.seen, f.drain()...)
	for _, m := range f.seen {
		if m["t"] == "medicOffer" || m["t"] == "medicResult" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("three frames inside 200 ms produced %d answers, want 1", n)
	}
}

// --- offer generation -----------------------------------------------------

// Every offer must come from the medic's own island pool, with an amount inside
// the rule's [min, max].
func TestMedicOffersComeFromTheIslandPool(t *testing.T) {
	f := newFixture(t)
	for _, island := range []string{"woods", "spire"} {
		md := f.medicOf(t, island)
		pool := f.r.defs.MedicTradePools[island]
		if len(pool) == 0 {
			t.Fatalf("no trade pool for %s", island)
		}
		for n := 0; n < 400; n++ {
			o := f.r.createMedicOffer("p", md, f.now)
			ok := false
			for _, rule := range pool {
				if rule.Resource == o.Resource && o.Amount >= rule.Min && o.Amount <= rule.Max {
					ok = true
					break
				}
			}
			if !ok {
				t.Fatalf("%s offer outside the pool: %s x%d", island, o.Resource, o.Amount)
			}
		}
	}
}

// weightedChoice must select strictly by cumulative weight, and never fall off
// the end for a roll of 1.
func TestWeightedChoiceBoundaries(t *testing.T) {
	pool := newFixture(t).r.defs.MedicTradePools["woods"] // wood 4, fiber 4, stone 2, meat 2
	total := 0
	for _, e := range pool {
		total += e.Weight
	}
	// A roll just under a boundary picks the entry that boundary closes.
	cum := 0
	for i, e := range pool {
		cum += e.Weight
		hi := float64(cum)/float64(total) - 1e-9
		if got := weightedChoice(pool, hi); got.Resource != e.Resource {
			t.Fatalf("roll just below boundary %d picked %s, want %s", i, got.Resource, e.Resource)
		}
		lo := float64(cum-e.Weight) / float64(total)
		if got := weightedChoice(pool, lo); got.Resource != e.Resource {
			t.Fatalf("roll at the start of band %d picked %s, want %s", i, got.Resource, e.Resource)
		}
	}
	if got := weightedChoice(pool, 1); got.Resource != pool[len(pool)-1].Resource {
		t.Fatalf("roll of exactly 1 must fall back to the last entry, got %s", got.Resource)
	}
}

// --- progression ----------------------------------------------------------

// usecore: only at the monolith, only with a core, only once each — and each
// one lit raises creature strength, which the Slice 3 spawn gates read.
func TestUseCoreGates(t *testing.T) {
	f := newFixture(t)
	mx, my := world.MONOLITHS[0][0], world.MONOLITHS[0][1]

	// out of range, holding a core
	f.p.X, f.p.Y, f.p.Z = float64(mx)+4, float64(my), 0
	f.p.Inv["core"] = 1
	f.r.handleUseCore(f.p, map[string]any{"t": "usecore", "i": float64(0)})
	if f.r.mono[0] || f.p.Inv["core"] != 1 {
		t.Fatalf("usecore worked from 4 tiles away: mono=%v core=%d", f.r.mono[0], f.p.Inv["core"])
	}

	// in range, no core
	f.p.X = float64(mx) + 2
	f.p.Inv["core"] = 0
	f.r.handleUseCore(f.p, map[string]any{"t": "usecore", "i": float64(0)})
	if f.r.mono[0] {
		t.Fatal("usecore lit a monolith without a core")
	}

	// out-of-range indices are refused rather than indexing the array
	f.p.Inv["core"] = 1
	for _, bad := range []any{float64(-1), float64(4), float64(0.5), "0", nil} {
		f.r.handleUseCore(f.p, map[string]any{"t": "usecore", "i": bad})
	}
	if f.p.Inv["core"] != 1 || f.r.mono != [4]bool{} {
		t.Fatalf("a bad index spent a core: core=%d mono=%v", f.p.Inv["core"], f.r.mono)
	}

	// the real thing
	f.reset()
	before := f.r.strength()
	f.r.handleUseCore(f.p, map[string]any{"t": "usecore", "i": float64(0)})
	if !f.r.mono[0] || f.p.Inv["core"] != 0 {
		t.Fatalf("usecore failed: mono=%v core=%d", f.r.mono[0], f.p.Inv["core"])
	}
	if m := f.lastOfType("mono"); m == nil || int(m["i"].(float64)) != 0 {
		t.Fatalf("no mono broadcast: %v", m)
	}
	if f.r.strength() != before+1 {
		t.Fatalf("strength should rise with the monolith: %d -> %d", before, f.r.strength())
	}

	// and it cannot be lit twice
	f.p.Inv["core"] = 1
	f.r.handleUseCore(f.p, map[string]any{"t": "usecore", "i": float64(0)})
	if f.p.Inv["core"] != 1 {
		t.Fatal("re-lighting an awakened monolith spent a second core")
	}
}

// --- the wave -------------------------------------------------------------

// The 4-minute assault ends in victory, which also zeroes the creature cap.
func TestWaveVictory(t *testing.T) {
	f := newFixture(t)
	f.r.wave = &waveState{until: f.now + 240000, engineI: world.ACTIVATION_I}
	f.reset()
	f.r.onSimTick()
	if f.r.won || f.r.wave == nil {
		t.Fatal("the wave ended before its 4 minutes were up")
	}
	f.now += 240001
	f.reset()
	f.r.onSimTick()
	if !f.r.won || f.r.wave != nil {
		t.Fatalf("the wave should have been won: won=%v wave=%v", f.r.won, f.r.wave)
	}
	if m := f.lastOfType("win"); m == nil {
		t.Fatal("no win broadcast")
	}
}

// Demolishing your own Engine mid-assault cancels the wave and says so.
func TestSelfDestroyedEngineCancelsWave(t *testing.T) {
	f := newFixture(t)
	i := world.ACTIVATION_I
	x, y := float64(i%world.SIZE), float64(i/world.SIZE)
	f.stand(x+1, y, 0)
	f.r.structures[i] = &Structure{Kind: "engine", HP: 2, Owner: f.p.S.ID, Lvl: 1}
	f.r.wave = &waveState{until: f.now + 240000, engineI: i}
	f.p.Equip = "isword" // 5 dmg, doubled for demolition
	f.reset()
	f.r.handleAtk(f.p, map[string]any{"t": "atk"})
	if f.r.wave != nil {
		t.Fatal("demolishing the Engine did not cancel the wave")
	}
	f.seen = append(f.seen, f.drain()...)
	var sawStop, sawMsg bool
	for _, m := range f.seen {
		if m["t"] == "wave" && m["secs"].(float64) == 0 {
			sawStop = true
		}
		if m["t"] == "msg" && m["s"] == "You destroyed your own World Engine!" {
			sawMsg = true
		}
	}
	if !sawStop || !sawMsg {
		t.Fatalf("expected wave secs:0 and the self-destruct message (stop=%v msg=%v)", sawStop, sawMsg)
	}
}

// --- dev gating -----------------------------------------------------------

// The gate: a ticket claim wins, and with no claim the env-derived config
// decides. Both directions matter — a stray true would hand every player the
// world-mutating commands.
func TestDevGateClaimOverridesConfig(t *testing.T) {
	f := newFixture(t)
	yes, no := true, false

	f.r.cfg.DevTools = false
	f.p.S.DevClaim = nil
	if f.r.devAllowed(f.p) {
		t.Fatal("no claim and HEARTH_DEV unset must refuse")
	}
	f.reset()
	f.r.handleDev(f.p)
	if m := f.lastOfType("msg"); m == nil || m["s"] != devOffMsg {
		t.Fatalf("expected the dev-off message, got %v", m)
	}
	if f.p.Inv["wood"] != 0 {
		t.Fatalf("the refused dev kit still granted materials: wood=%d", f.p.Inv["wood"])
	}

	f.r.cfg.DevTools = true
	if !f.r.devAllowed(f.p) {
		t.Fatal("HEARTH_DEV should allow when the ticket says nothing")
	}
	f.p.S.DevClaim = &no
	if f.r.devAllowed(f.p) {
		t.Fatal("an explicit dev:false claim must beat HEARTH_DEV")
	}
	f.r.cfg.DevTools = false
	f.p.S.DevClaim = &yes
	if !f.r.devAllowed(f.p) {
		t.Fatal("an explicit dev:true claim must beat an unset HEARTH_DEV")
	}

	// and the kit itself
	f.reset()
	f.r.handleDev(f.p)
	if f.p.Inv["wood"] != devKitInv["wood"] || !f.p.Tools["isword"] || !f.p.Gear["furcloak"] {
		t.Fatalf("dev kit incomplete: wood=%d tools=%v gear=%v", f.p.Inv["wood"], f.p.Tools, f.p.Gear)
	}
	if f.p.HP != f.r.defs.MaxHP {
		t.Fatalf("dev kit should top up hp, got %d", f.p.HP)
	}
}

// god mode: healed back to full every tick, cleared by `kill`.
func TestDevGodModeAndKill(t *testing.T) {
	f := newFixture(t)
	yes := true
	f.p.S.DevClaim = &yes
	f.r.handleDevCmd(f.p, map[string]any{"t": "devcmd", "cmd": "god"})
	if !f.p.God {
		t.Fatal("god mode did not turn on")
	}
	f.p.HP = 1
	f.r.godTick()
	if f.p.HP != f.r.defs.MaxHP {
		t.Fatalf("god mode did not heal: hp=%d", f.p.HP)
	}
	f.r.handleDevCmd(f.p, map[string]any{"t": "devcmd", "cmd": "kill"})
	if f.p.God {
		t.Fatal("kill should clear god mode")
	}
	sp := f.r.spawn
	if math.Hypot(f.p.X-float64(sp[0]), f.p.Y-float64(sp[1])) > 2 {
		t.Fatalf("kill did not respawn at the spawn point: (%v,%v)", f.p.X, f.p.Y)
	}
}

// `spawn` places exactly one creature of the requested type, unleashed, with
// strength-scaled hp; `clearcre` empties both the map and its ordered mirror.
func TestDevSpawnAndClear(t *testing.T) {
	f := newFixture(t)
	yes := true
	f.p.S.DevClaim = &yes
	f.r.mono = [4]bool{true, true, false, false} // strength 3

	f.r.handleDevCmd(f.p, map[string]any{"t": "devcmd", "cmd": "spawn", "type": "brute"})
	if len(f.r.creatures) != 1 || len(f.r.creOrder) != 1 {
		t.Fatalf("spawn produced %d creatures / %d in creOrder", len(f.r.creatures), len(f.r.creOrder))
	}
	c := f.r.creOrder[0]
	ct := creTypes["brute"]
	if c.HP != ct.hpBase+ct.hpStr*3 {
		t.Fatalf("spawned hp %d, want %d", c.HP, ct.hpBase+ct.hpStr*3)
	}
	if c.HasHome {
		t.Fatal("a dev-spawned creature must be unleashed (no home tile)")
	}

	f.r.handleDevCmd(f.p, map[string]any{"t": "devcmd", "cmd": "spawn", "type": "not_a_monster"})
	if len(f.r.creatures) != 1 {
		t.Fatal("an unknown type spawned something")
	}

	f.r.handleDevCmd(f.p, map[string]any{"t": "devcmd", "cmd": "clearcre"})
	if len(f.r.creatures) != 0 || len(f.r.creOrder) != 0 {
		t.Fatalf("clearcre left %d creatures / %d in creOrder", len(f.r.creatures), len(f.r.creOrder))
	}
}

// `mono` lights a monolith once, and announces the Engine only when the fourth
// one closes the set.
func TestDevMonoCommand(t *testing.T) {
	f := newFixture(t)
	yes := true
	f.p.S.DevClaim = &yes
	for i := 0; i < 3; i++ {
		f.reset()
		f.r.handleDevCmd(f.p, map[string]any{"t": "devcmd", "cmd": "mono", "i": float64(i)})
		if m := f.lastOfType("msg"); m != nil {
			t.Fatalf("monolith %d should not announce the Engine yet: %v", i, m)
		}
	}
	f.reset()
	f.r.handleDevCmd(f.p, map[string]any{"t": "devcmd", "cmd": "mono", "i": float64(3)})
	if m := f.lastOfType("msg"); m == nil || m["s"] != "All Monoliths lit — build the Engine at the Core." {
		t.Fatalf("expected the all-lit message, got %v", m)
	}
	if !allTrue(f.r.mono) {
		t.Fatal("not all monoliths were lit")
	}
}
