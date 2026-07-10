from src.linkedin_posters import parse_hiring_team_from_html

SAMPLE_HTML = """
<section>
  <h2>Meet the hiring team</h2>
  <div>
    <a href="https://www.linkedin.com/in/robert-mari-93b235175?trk=foo">Robert Mari</a>
    <span>Human Resources Business Partner at Versace</span>
    <span>Job poster</span>
  </div>
</section>
"""

MESSAGE_RECRUITER_HTML = """
<div class="message-the-recruiter">
  <p>Direct message the job poster from Allegiance Group</p>
  <div class="base-main-card">
    <a href="https://www.linkedin.com/in/scottcarline">
      <span class="sr-only">Scott Carline</span>
    </a>
    <span>Construction Headhunter</span>
  </div>
</div>
"""


def test_parse_hiring_team_from_html():
    posters = parse_hiring_team_from_html(SAMPLE_HTML)
    assert len(posters) == 1
    assert posters[0].name == "Robert Mari"
    assert posters[0].linkedin_url == "https://www.linkedin.com/in/robert-mari-93b235175"
    assert posters[0].is_job_poster is True


def test_parse_message_the_recruiter():
    posters = parse_hiring_team_from_html(MESSAGE_RECRUITER_HTML)
    assert len(posters) == 1
    assert posters[0].name == "Scott Carline"
    assert posters[0].is_job_poster is True
