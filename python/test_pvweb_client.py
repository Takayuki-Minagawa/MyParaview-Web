from pvweb_client import PVWebClient


def test_view_url():
    client = PVWebClient("https://viewer.example/")
    assert client.view_url(project_id="p 1", dataset_id="d/2") == (
        "https://viewer.example/?project=p+1&dataset=d%2F2"
    )


def test_view_url_merges_query_before_fragment():
    client = PVWebClient("https://viewer.example/app?tenant=a#panel")
    assert client.view_url(project_id="p", pipeline_id="pipe") == (
        "https://viewer.example/app?tenant=a&project=p&pipeline=pipe#panel"
    )


def test_view_url_replaces_reserved_deep_link_query():
    client = PVWebClient("https://viewer.example/app?dataset=old&pipeline=old&tenant=a")
    url = client.view_url(project_id="new", dataset_id="fresh")
    assert url == "https://viewer.example/app?tenant=a&project=new&dataset=fresh"
