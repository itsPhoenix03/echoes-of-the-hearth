package world

import "testing"

// Values captured from shared/world.js for seed "hearth-1".
func TestDerivedHelpersMatchJS(t *testing.T) {
	w := GenWorld("hearth-1")
	if got := FindSpawn(w); got != [2]int{168, 168} {
		t.Errorf("FindSpawn = %v, want [168 168]", got)
	}
	if got := NearestLand(w, 640, 300); got != [2]float64{637, 197} {
		t.Errorf("NearestLand = %v, want [637 197]", got)
	}
	medics, err := FindMedicSpawns(w)
	if err != nil {
		t.Fatal(err)
	}
	want := []Medic{
		{"medic-woods", "woods", "medic", 190, 172, "medic_hut", 190, 170},
		{"medic-spire", "spire", "medic_snow", 189, 1107, "medic_hut_snow", 189, 1105},
	}
	for i := range want {
		if medics[i] != want[i] {
			t.Errorf("medic[%d] = %+v, want %+v", i, medics[i], want[i])
		}
	}
}
