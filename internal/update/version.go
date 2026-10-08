package update

import (
	"cmp"
	"strconv"
	"strings"
)

func normalizeVersion(v string) string {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "refs/tags/")
	v = strings.TrimPrefix(v, "release-")
	v = strings.TrimPrefix(v, "v")
	return v
}

func isDevVersion(v string) bool {
	v = strings.TrimSpace(strings.ToLower(v))
	return v == "" || v == "dev" || v == "development" || strings.Contains(v, "dirty")
}

func compareVersions(a, b string) int {
	a = normalizeVersion(a)
	b = normalizeVersion(b)
	ap, ahotfix, aok := parseVersionParts(a)
	bp, bhotfix, bok := parseVersionParts(b)
	if !aok || !bok {
		return strings.Compare(a, b)
	}
	for i := 0; i < len(ap) || i < len(bp); i++ {
		var av, bv int
		if i < len(ap) {
			av = ap[i]
		}
		if i < len(bp) {
			bv = bp[i]
		}
		if av < bv {
			return -1
		}
		if av > bv {
			return 1
		}
	}
	return cmp.Compare(ahotfix, bhotfix)
}

// parseVersionParts splits a version into its numeric release parts and its
// hotfix number. Hotfixes of a release are published as 0.5.1fix, 0.5.1fix2,
// and so on: they follow that release and precede the next one. A bare "fix"
// is the first hotfix, and a plain release has hotfix number zero.
func parseVersionParts(v string) ([]int, int, bool) {
	base := strings.Split(v, "-")[0]
	hotfix := 0
	if release, number, found := strings.Cut(base, "fix"); found {
		base, hotfix = release, 1
		if number != "" {
			parsed, err := strconv.Atoi(number)
			if err != nil {
				return nil, 0, false
			}
			hotfix = parsed
		}
	}
	if base == "" {
		return nil, 0, false
	}
	raw := strings.Split(base, ".")
	parts := make([]int, 0, len(raw))
	for _, part := range raw {
		if part == "" {
			return nil, 0, false
		}
		n, err := strconv.Atoi(part)
		if err != nil {
			return nil, 0, false
		}
		parts = append(parts, n)
	}
	return parts, hotfix, true
}
