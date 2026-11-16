# Recording the owner's fixtures

Movement templates (`squat`, `push-up`, `lunge`, `hip-hinge`) and the
derailleur use case (14.2) are validated on clips the owner records with
consent. Until they exist,
`video.pose` reports a template's measures with `validated: false` and names
no faults. No recorded clip is committed: each is listed by sha256 under
`recorded` in `fixtures/manifest.json`, with its annotations, and the clip
itself stays on the owner's machine.

## Consent

- Everyone filmed agrees in writing, before recording, to the clip's use for
  measuring Tavi's pose analysis on the owner's machine. They may withdraw at
  any time, and the clip and its annotations are then deleted.
- Faces are not needed. Frame the body from the shoulders down where you
  can, or let subjects wear a cap and look away.
- Film no children, and nobody who has not agreed: bystanders out of frame.
- A clip never leaves the owner's machine. No native video model and no
  remote analyser sees it during evaluation.

## Camera

- **Side-on**: the camera's axis is perpendicular to the subject's sagittal
  plane, within 10°, as checked on the floor with a tape line.
- **Height**: the lens at the subject's hip height, the camera level (a
  spirit level on the phone or tripod). The trunk-lean figure assumes a level
  camera.
- **Distance**: the whole body in frame with about 10% margin at the top and
  bottom of the deepest position, typically 3 to 4 m for a phone's main lens.
  Do not use the ultra-wide lens.
- **Light**: even and in front of the subject, never behind them.
- **Frame rate**: 30 fps at 1080p; one set at 240 fps for 14.2.
- A tripod. The `camera-moving` check flags a handheld clip.

## Sets

| Set | Clips |
| --- | --- |
| Squat | 3 subjects × 3 depths (above parallel, parallel, below) side-on at hip height; 1 oblique 45°; 1 front; 1 with the ankles cut off; 1 with a rack upright occluding the knee; 1 with two people in frame |
| Push-up, lunge, hip-hinge | Each side-on as above, plus one bad setup each |
| Shifting (14.2) | `shift-hesitate-low-tension` at 30 and 240 fps, `shift-overshoot-high-tension`, `shift-clean`; the derailleur filmed from the drive side at its height |

## Annotation

Two people annotate each squat clip independently in Kinovea (a separate,
GPLv2 tool, never linked into Tavi). Each marks the hip, knee and ankle
angles at the bottom of every rep, and the frame they chose. Record the
inter-rater agreement, and where you can, a goniometer reading at the
bottom. Results are reported as ICC and Bland-Altman limits per joint and
setup class.

Commit, under `recorded`: each clip's sha256, its setup (view, height,
distance, lighting, fps), each annotator's angles per rep, and the
agreement. A template's `validated` flag (`packages/contracts/src/movement-templates.ts`)
is flipped by the commit that records its fixtures passing.
