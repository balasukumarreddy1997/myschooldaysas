import { useState } from "react";
import { ArrowRight, BookOpen, Check, GraduationCap, ShieldCheck } from "lucide-react";
import "./_group.css";
import "./premium.css";

const schoolName = "St Joseph's Public School";
const platformName = "My School Day";

export function Premium() {
  const [message, setMessage] = useState("");

  return (
    <main className="premium-login min-h-[100dvh]">
      <section className="premium-story" aria-label="School welcome">
        <div className="premium-orbit premium-orbit-one" />
        <div className="premium-orbit premium-orbit-two" />
        <div className="premium-story-top">
          <div className="premium-crest" aria-hidden="true">
            <GraduationCap size={25} strokeWidth={1.7} />
          </div>
          <div>
            <p className="premium-school-name">{schoolName}</p>
            <p className="premium-platform">{platformName}</p>
          </div>
        </div>

        <div className="premium-story-copy">
          <div className="premium-eyebrow"><span /> A school community, connected</div>
          <h1>Every day<br />begins <em>together.</em></h1>
          <p>One trusted place for the people and moments that make a school day matter.</p>
        </div>

        <div className="premium-story-footer">
          <BookOpen size={17} strokeWidth={1.7} />
          <span>Learning, belonging, becoming.</span>
          <span className="premium-footer-rule" />
          <span>EST. WITH CARE</span>
        </div>
        <div className="premium-side-mark" aria-hidden="true">SJP&nbsp; · &nbsp;MY SCHOOL DAY</div>
      </section>

      <section className="premium-form-panel" aria-label="Sign in">
        <div className="premium-mobile-brand">
          <div className="premium-crest" aria-hidden="true"><GraduationCap size={23} /></div>
          <div>
            <p className="premium-school-name">{schoolName}</p>
            <p className="premium-platform">{platformName}</p>
          </div>
        </div>
        <div className="premium-form-wrap">
          <div className="premium-form-heading">
            <div className="premium-kicker"><span className="premium-kicker-dot" /> SCHOOL PORTAL</div>
            <h2>Welcome back.</h2>
            <p>Sign in with your school account to continue.</p>
          </div>

          <form onSubmit={(event) => {
            event.preventDefault();
            setMessage("This is a visual preview. Sign in on the school app.");
          }}>
            <label className="premium-label" htmlFor="premium-organization">Organization</label>
            <input id="premium-organization" required autoComplete="organization" className="premium-input" placeholder="Your school's organization" />

            <label className="premium-label premium-label-spaced" htmlFor="premium-email">Email address</label>
            <input id="premium-email" required type="email" autoComplete="username" className="premium-input" placeholder="name@school.edu.in" />

            <label className="premium-label premium-label-spaced" htmlFor="premium-password">Password</label>
            <input id="premium-password" required type="password" autoComplete="current-password" className="premium-input" placeholder="Enter your password" />

            {message && <p className="premium-status" role="status">{message}</p>}
            <button className="premium-submit" type="submit">
              <span>Sign in</span><ArrowRight size={17} strokeWidth={1.8} />
            </button>
          </form>

          <div className="premium-assurance">
            <div className="premium-assurance-icon"><ShieldCheck size={17} strokeWidth={1.8} /></div>
            <div><strong>A considered space for your school.</strong><span>Your school credentials stay protected.</span></div>
            <Check className="premium-assurance-check" size={16} />
          </div>
        </div>
        <div className="premium-panel-footer"><span>MY SCHOOL DAY</span><span>ST JOSEPH'S PUBLIC SCHOOL</span></div>
      </section>
    </main>
  );
}
