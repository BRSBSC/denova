package update

import (
	"path/filepath"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	tests := []struct {
		name string
		a    string
		b    string
		want int
	}{
		{name: "same with v prefix", a: "v0.1.10", b: "0.1.10", want: 0},
		{name: "patch newer", a: "0.1.9", b: "0.1.10", want: -1},
		{name: "minor newer", a: "0.2.0", b: "0.1.99", want: 1},
		{name: "missing patch equals zero", a: "1.0", b: "1.0.0", want: 0},
		// A hotfix release such as 0.5.1fix9 follows the release it patches.
		{name: "hotfix follows its release", a: "0.5.1fix9", b: "0.5.1", want: 1},
		{name: "bare hotfix is the first one", a: "v0.5.1fix", b: "0.5.1fix2", want: -1},
		{name: "hotfix numbers compare numerically", a: "0.5.1fix10", b: "0.5.1fix9", want: 1},
		{name: "next patch follows a hotfix", a: "0.5.1fix9", b: "0.5.2", want: -1},
		{name: "two-digit patch follows a hotfix", a: "0.5.1fix9", b: "0.5.10", want: -1},
		{name: "two-digit minor follows a hotfix", a: "0.5.1fix9", b: "0.10.0", want: -1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := compareVersions(tt.a, tt.b)
			switch {
			case tt.want == 0 && got != 0:
				t.Fatalf("compareVersions(%q,%q)=%d want 0", tt.a, tt.b, got)
			case tt.want < 0 && got >= 0:
				t.Fatalf("compareVersions(%q,%q)=%d want <0", tt.a, tt.b, got)
			case tt.want > 0 && got <= 0:
				t.Fatalf("compareVersions(%q,%q)=%d want >0", tt.a, tt.b, got)
			}
		})
	}
}

func TestDevVersion(t *testing.T) {
	for _, v := range []string{"", "dev", "development", "0.1.10-dirty"} {
		if !isDevVersion(v) {
			t.Fatalf("%q should be treated as dev", v)
		}
	}
	if isDevVersion("0.1.10") {
		t.Fatalf("release version should not be dev")
	}
}

func TestLocalArchiveNameAcceptsHotfixVersions(t *testing.T) {
	for name, version := range map[string]string{
		"denova-v0.5.1-linux-x64.tar.gz":       "0.5.1",
		"denova-v0.5.1fix-darwin-arm64.tar.gz": "0.5.1fix",
		"denova-v0.5.1fix10-windows-x64.zip":   "0.5.1fix10",
	} {
		if match := archiveNamePattern.FindStringSubmatch(name); len(match) != 5 || match[1] != version {
			t.Fatalf("%s parsed as %q, want version %s", name, match, version)
		}
	}
	for _, name := range []string{"denova-v0.5.1beta-linux-x64.tar.gz", "denova-v0.5.1fix9x-linux-x64.tar.gz", "denova-v0.5.1-fix9-linux-x64.tar.gz"} {
		if archiveNamePattern.MatchString(name) {
			t.Fatalf("%s must not be accepted as a release package", name)
		}
	}
}

func TestStatusLinksToTheBuildRepositoryReleases(t *testing.T) {
	service := &Service{repository: "owner/fork", currentVersion: "0.5.1fix9", executablePath: filepath.Join(t.TempDir(), "denova")}
	status, err := service.Status()
	if err != nil || status.ReleasesURL != "https://github.com/owner/fork/releases/latest" {
		t.Fatalf("status=%#v err=%v", status, err)
	}
}
