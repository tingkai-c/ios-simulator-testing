import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = DemoController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

final class DemoController: UIViewController {
    private let countLabel = UILabel()
    private var count = UserDefaults.standard.integer(forKey: "harnessCount")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        countLabel.accessibilityIdentifier = "harness-count"
        countLabel.font = .systemFont(ofSize: 28)
        countLabel.textAlignment = .center
        updateLabel()

        let increment = UIButton(type: .system)
        increment.setTitle("Increment", for: .normal)
        increment.accessibilityLabel = "Increment"
        increment.accessibilityIdentifier = "harness-increment"
        increment.titleLabel?.font = .systemFont(ofSize: 24)
        increment.addTarget(self, action: #selector(incrementCount), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [countLabel, increment])
        stack.axis = .vertical
        stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.widthAnchor.constraint(equalTo: view.widthAnchor, multiplier: 0.8),
            increment.heightAnchor.constraint(equalToConstant: 60),
        ])
    }

    @objc private func incrementCount() {
        count += 1
        UserDefaults.standard.set(count, forKey: "harnessCount")
        updateLabel()
    }

    private func updateLabel() {
        countLabel.text = "Count: \(count)"
        countLabel.accessibilityLabel = "Count: \(count)"
    }
}
