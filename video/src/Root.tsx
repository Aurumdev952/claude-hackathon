import { Composition } from "remotion";
import { webglAvailable } from "./scenes/BodyTurntable3D";
import { MinistryReel, PatientCaseSummary, FPS, SIZES, ministryDuration, patientDuration } from "./compositions";
import type { MinistryReelProps, PatientVideoProps } from "./props";
import { SAMPLE_MINISTRY, SAMPLE_PATIENT } from "./samples";

type PatientComp = PatientVideoProps & { force2d?: boolean };

/** 1-frame probe used by the renderer to pick a GL backend: it fails when this Chromium has no WebGL. */
const GlCheck = () => {
  if (!webglAvailable()) throw new Error("NO_WEBGL");
  return null;
};

/** Duration depends on which scenes have data (calculateMetadata). */
export const RemotionRoot = () => (
  <>
    <Composition id="GlCheck" component={GlCheck} width={64} height={64} fps={30} durationInFrames={1} />
    <Composition id="PatientCaseSummary" component={PatientCaseSummary as React.FC<PatientComp>} fps={FPS} {...SIZES.landscape}
                 durationInFrames={patientDuration(SAMPLE_PATIENT)} defaultProps={SAMPLE_PATIENT as PatientComp}
                 calculateMetadata={({ props }) => ({ durationInFrames: patientDuration(props) })} />
    <Composition id="MinistryReel" component={MinistryReel as React.FC<MinistryReelProps>} fps={FPS} {...SIZES.landscape}
                 durationInFrames={ministryDuration(SAMPLE_MINISTRY)} defaultProps={SAMPLE_MINISTRY}
                 calculateMetadata={({ props }) => ({ durationInFrames: ministryDuration(props) })} />
    <Composition id="MinistryReelVertical" component={MinistryReel as React.FC<MinistryReelProps>} fps={FPS} {...SIZES.vertical}
                 durationInFrames={ministryDuration(SAMPLE_MINISTRY)} defaultProps={SAMPLE_MINISTRY}
                 calculateMetadata={({ props }) => ({ durationInFrames: ministryDuration(props) })} />
  </>
);
