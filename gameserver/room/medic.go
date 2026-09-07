package room

import (
	"fmt"
	"math"
	"math/rand"

	"hearth/gameserver/defs"
	"hearth/gameserver/world"
)

// Slice 4: the medic NPC and its bargain state machine.
//
// Two medics exist, both deterministic functions of the seed (world.
// FindMedicSpawns): one on the Woods and one on the Frozen Spire. They cannot be
// attacked, harvested or built on — their tile and their hut tile are in
// r.medicTiles, which blocked/posBlocked/build/creature-pathing all consult.
//
// The bargain is a three-message state machine over ONE offer per player:
//
//	inspect  -> `medicOffer` carrying a server-generated offer (or a rejection)
//	accept   -> `medicResult` ok, having taken payment and healed to full
//	decline  -> `medicOffer` with offer:null, and a 20 s reroll cooldown
//
// Two properties are load-bearing and are what the tests below pin down:
//
//   - Stability. A repeat `inspect` while the current offer is live returns the
//     SAME offer id. The client shows the price in a dialogue, so a reroll on
//     every keypress would let a player fish for a cheap bargain.
//   - Atomicity. Payment and healing happen together or not at all. The three
//     guards before the deduction (alive, not already full, can afford) are
//     exactly the three conditions under which healPlayer can return zero, so
//     the deduction below them can never buy nothing.
//
// Offer bookkeeping needs no ordered mirror: medicOffers and medicRerollAt are
// keyed by session id and hold at most one entry per player, and nothing reads
// them by iteration — so unlike creOrder/aniOrder/playerOrder/infOrder there is
// no outcome for Go's map order to change.

// Offer timings, from server/index.js and docs/05 §3.
const (
	medicOfferTTLMs   = 60000 // an offer is live for 60 s
	medicRerollMs     = 20000 // after an expiry or a decline, no new offer for 20 s
	medicCombatLockMs = 5000  // no treatment within 5 s of taking combat damage
	medicSpamMs       = 200   // per-player floor between medic frames
	medicRangeTiles   = 2.5   // interaction radius
)

// medicOffer is one live bargain. It is bound to the player, the medic and an
// opaque id, so a stale or replayed `accept` from another dialogue cannot spend
// it (docs/05 §3).
type medicOffer struct {
	ID        string
	PlayerID  string
	MedicID   string
	IslandID  string
	Resource  string
	Amount    int
	CreatedAt int64
	ExpiresAt int64
}

// weightedChoice is the legacy helper: walk the entries subtracting weights
// from a roll over the total. The final fallback matters when floating-point
// error leaves the roll a hair above the sum.
func weightedChoice(entries []defs.TradeRule, roll01 float64) defs.TradeRule {
	total := 0
	for _, e := range entries {
		total += e.Weight
	}
	roll := roll01 * float64(total)
	for _, e := range entries {
		roll -= float64(e.Weight)
		if roll < 0 {
			return e
		}
	}
	return entries[len(entries)-1]
}

// createMedicOffer picks a rule from the medic's island pool and mints an offer,
// replacing whatever that player had before.
func (r *Room) createMedicOffer(playerID string, medic *world.Medic, now int64) *medicOffer {
	pool := r.defs.MedicTradePools[medic.IslandID]
	if len(pool) == 0 {
		return nil
	}
	rule := weightedChoice(pool, rand.Float64())
	// rule.min + floor(random() * (rule.max - rule.min + 1))
	amount := rule.Min + int(math.Floor(rand.Float64()*float64(rule.Max-rule.Min+1)))
	r.nextMedicOffer++
	o := &medicOffer{
		ID:       fmt.Sprintf("%s:%d", playerID, r.nextMedicOffer),
		PlayerID: playerID, MedicID: medic.ID, IslandID: medic.IslandID,
		Resource: rule.Resource, Amount: amount,
		CreatedAt: now, ExpiresAt: now + medicOfferTTLMs,
	}
	r.medicOffers[playerID] = o
	return o
}

// publicOffer is what goes on the wire: the id, the price and a relative expiry.
// createdAt and the owning player id stay server-side.
func (r *Room) publicOffer(o *medicOffer, now int64) map[string]any {
	return map[string]any{
		"id": o.ID, "medicId": o.MedicID, "resource": o.Resource, "amount": o.Amount,
		"expiresInMs": maxInt64(0, o.ExpiresAt-now),
	}
}

// forgetMedic clears a departing player's bargain state. Called from
// removePlayer — the legacy server does the same on `close`, and leaving it
// behind would leak an offer keyed by a session id that can never return.
func (r *Room) forgetMedic(id string) {
	delete(r.medicOffers, id)
	delete(r.medicRerollAt, id)
}

// medicByID finds a medic by its stable id ("medic-woods" / "medic-spire").
func (r *Room) medicByID(id string) *world.Medic {
	for i := range r.medics {
		if r.medics[i].ID == id {
			return &r.medics[i]
		}
	}
	return nil
}

func (r *Room) handleMedic(p *Player, m map[string]any) {
	now := r.now()
	// The rejection echoes back the id the CLIENT asked about, not a resolved
	// one — on unknown-medic there is nothing to resolve, and the client keys
	// its dialogue by the id it sent.
	medicFail := func(reason string) {
		out := map[string]any{"t": "medicResult", "ok": false, "reason": reason}
		if v, ok := m["medicId"]; ok {
			out["medicId"] = v
		}
		r.send(p, out)
	}

	medic := r.medicByID(getString(m, "medicId"))
	if medic == nil {
		medicFail("unknown-medic")
		return
	}
	if p.Z != 0 {
		medicFail("wrong-level")
		return
	}
	if math.Hypot(float64(medic.X)-p.X, float64(medic.Y)-p.Y) > medicRangeTiles {
		medicFail("too-far")
		return
	}
	// Combat-only lockout. Environmental chip damage (snow, desert, thermal
	// water) deliberately does NOT stamp LastDamageAt — see the note in
	// survivalTick. If it did, the Spire medic would be unreachable without the
	// very Fur Cloak you would visit them to survive without.
	if now-p.LastDamageAt < medicCombatLockMs {
		medicFail("in-combat")
		return
	}
	if now-p.LastMedicAt < medicSpamMs {
		return // silent, as in the legacy server: this is packet-spam damping
	}
	p.LastMedicAt = now

	switch getString(m, "action") {
	case "inspect":
		r.medicInspect(p, medic, now)
	case "accept":
		r.medicAccept(p, medic, m, now, medicFail)
	case "decline":
		r.forgetMedic(p.S.ID)
		r.medicRerollAt[p.S.ID] = now + medicRerollMs
		r.send(p, map[string]any{"t": "medicOffer", "medicId": medic.ID, "offer": nil})
	}
}

// medicInspect answers with the live offer, a fresh one, or a rejection.
func (r *Room) medicInspect(p *Player, medic *world.Medic, now int64) {
	id := p.S.ID
	medicFail := func(reason string) {
		r.send(p, map[string]any{"t": "medicResult", "ok": false, "medicId": medic.ID, "reason": reason})
	}
	if p.HP <= 0 {
		medicFail("dead")
		return
	}
	if p.HP >= r.defs.MaxHP {
		medicFail("full-health")
		return
	}
	existing := r.medicOffers[id]
	// Stability: the same medic, still live -> the identical offer, every time.
	if existing != nil && existing.MedicID == medic.ID && existing.ExpiresAt > now {
		r.send(p, map[string]any{
			"t": "medicOffer", "medicId": medic.ID, "offer": r.publicOffer(existing, now),
			"hp": p.HP, "maxHp": r.defs.MaxHP,
		})
		return
	}
	// An offer that ran out costs a 20 s reroll delay, so letting one lapse is
	// not a free way to shop for a better price. Note an offer from the OTHER
	// medic that is still live falls through both branches and is simply
	// replaced — the legacy behaviour, and the reason each medic quotes its own
	// island's pool.
	if existing != nil && existing.ExpiresAt <= now {
		delete(r.medicOffers, id)
		r.medicRerollAt[id] = now + medicRerollMs
	}
	if r.medicRerollAt[id] > now {
		medicFail("rate-limited")
		return
	}
	offer := r.createMedicOffer(id, medic, now)
	if offer == nil {
		medicFail("unknown-medic") // no pool for this island: nothing to trade
		return
	}
	r.send(p, map[string]any{
		"t": "medicOffer", "medicId": medic.ID, "offer": r.publicOffer(offer, now),
		"hp": p.HP, "maxHp": r.defs.MaxHP,
	})
}

// medicAccept is the pay-then-heal transaction.
func (r *Room) medicAccept(p *Player, medic *world.Medic, m map[string]any, now int64, medicFail func(string)) {
	id := p.S.ID
	offer := r.medicOffers[id]
	// The offer id is compared as a string: a client that omits it, or sends a
	// number, matches nothing.
	if offer == nil || offer.ID != getString(m, "offerId") || offer.MedicID != medic.ID {
		medicFail("offer-mismatch")
		return
	}
	if offer.ExpiresAt <= now {
		delete(r.medicOffers, id)
		medicFail("offer-expired")
		return
	}
	// --- the atomicity guards. Everything that could make the heal a no-op is
	// checked BEFORE the resource is deducted, and nothing between them can
	// change player state, so there is no window in which a player pays and is
	// not healed.
	if p.HP <= 0 {
		medicFail("dead")
		return
	}
	if p.HP >= r.defs.MaxHP {
		medicFail("full-health")
		return
	}
	if p.Inv[offer.Resource] < offer.Amount {
		medicFail("insufficient-resource")
		return
	}
	missing := r.defs.MaxHP - p.HP // treatment always restores to full
	p.Inv[offer.Resource] -= offer.Amount
	healed := r.healPlayer(p, missing, "medic")
	delete(r.medicOffers, id)
	r.sendInv(p)
	r.send(p, map[string]any{
		"t": "medicResult", "ok": true, "medicId": medic.ID,
		"paid": map[string]any{"resource": offer.Resource, "amount": offer.Amount},
		"hp":   p.HP, "healed": healed,
	})
}
